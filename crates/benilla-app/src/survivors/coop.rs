//! Fork-only co-op presentation. The parent page owns transport and the authoritative Rust
//! simulation; this adapter reuses benilla's terrain, unit dressing and animation pipeline.
use azeroth_coop::World;
use benilla_world::{view::WorldCamera, world_point::WorldPoint};
use bevy::prelude::*;
use wasm_bindgen::JsValue;

use super::{data, units};
use crate::creature_anim::{move_flags, MovementState};

#[derive(Resource, Default)]
struct View {
    state: World,
    tick: Option<u32>,
    local: u32,
}
#[derive(Component)]
struct Body(u32, bool);
#[derive(Component)]
struct Telegraph;
#[derive(Component)]
struct Pickup(u32);
#[derive(Component)]
struct Corpse(f32);

pub(super) fn plugin(app: &mut App) {
    benilla_world::world_map::set_start_map(0);
    app.insert_resource(crate::run_mode::CaptureMode)
        .init_resource::<View>()
        .add_plugins(super::grade::plugin)
        .add_systems(Update, super::hero::daylight)
        .add_systems(
            Update,
            (receive, present, visuals, reap, camera)
                .chain()
                .after(benilla_world::schedule::WorldStage::Input),
        );
}
fn parent() -> Option<JsValue> {
    js_sys::Reflect::get(&js_sys::global(), &"parent".into()).ok()
}
fn receive(mut view: ResMut<View>) {
    let Some(parent) = parent() else {
        return;
    };
    let Ok(bridge) = js_sys::Reflect::get(&parent, &"__azeroth_coop".into()) else {
        return;
    };
    let Ok(state) = js_sys::Reflect::get(&bridge, &"state".into()) else {
        return;
    };
    let tick = js_sys::Reflect::get(&state, &"tick".into())
        .ok()
        .and_then(|v| v.as_f64())
        .map(|v| v as u32);
    if tick.is_none() || view.tick == tick {
        return;
    }
    let Some(json) = js_sys::JSON::stringify(&state)
        .ok()
        .and_then(|v| v.as_string())
    else {
        return;
    };
    if json.len() > 196608 {
        return;
    }
    if let Ok(state) = serde_json::from_str::<World>(&json) {
        view.state = state;
        view.tick = tick;
        view.local = js_sys::Reflect::get(&bridge, &"id".into())
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as u32;
    }
}
fn origin() -> Vec3 {
    let map = data::MAPS
        .iter()
        .find(|m| m.name == "Elwynn Forest")
        .unwrap_or(&data::MAPS[0]);
    units::wow_to_bevy(map.center)
}
fn position(p: azeroth_coop::Point, world: &WorldPoint) -> Vec3 {
    let mut pos = origin() + Vec3::new(p.x, 0.0, p.y);
    pos.y = world.terrain_height_under(pos).unwrap_or(pos.y);
    pos
}
fn present(
    mut commands: Commands,
    view: Res<View>,
    time: Res<Time>,
    world: WorldPoint,
    mut map: Option<ResMut<benilla_world::world_map::CurrentMap>>,
    mut bodies: Query<(
        Entity,
        &Body,
        &mut Transform,
        &mut MovementState,
        &mut crate::net::ObjectStore,
    )>,
    telegraphs: Query<Entity, With<Telegraph>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    if let Some(map) = map.as_mut() {
        map.0 = 0;
    }
    let mut wanted = Vec::new();
    if !view.state.players.is_empty() {
        for p in &view.state.players {
            if !p.connected {
                continue;
            }
            let class = data::CLASSES
                .iter()
                .find(|c| c.id == p.build.class())
                .unwrap_or(&data::CLASSES[0]);
            wanted.push((
                p.id,
                true,
                p.pos,
                p.hp,
                class.looks[0],
                1.0,
                class.weapons,
                class.sheath,
                class.id,
            ));
        }
        for e in &view.state.enemies {
            wanted.push((
                e.id,
                false,
                e.pos,
                e.hp,
                e.display,
                if e.boss { 1.8 } else { 1.0 },
                &[][..],
                0,
                1,
            ));
        }
    }
    let mut seen = std::collections::HashSet::new();
    for (entity, body, mut tf, mut movement, mut store) in &mut bodies {
        let Some(want) = wanted.iter().find(|w| w.0 == body.0 && w.1 == body.1) else {
            if !body.1 && view.state.phase == "playing" {
                units::kill_unit(&mut store);
                movement.speed = 0.0;
                movement.flags = 0;
                commands.entity(entity).remove::<Body>().insert(Corpse(1.5));
            } else {
                commands.entity(entity).despawn();
            }
            continue;
        };
        seen.insert((body.0, body.1));
        let to = position(want.2, &world);
        let delta = to - tf.translation;
        let moving = units::flat(delta).length_squared() > 0.002 && want.3 > 0.0;
        tf.translation = tf.translation.lerp(to, (time.delta_secs() * 14.0).min(1.0));
        if moving {
            tf.rotation = Quat::from_rotation_y(units::yaw_toward(delta));
        }
        movement.speed = if moving { 7.0 } else { 0.0 };
        movement.flags = if moving { move_flags::FORWARD } else { 0 };
        store
            .0
            .merge(benilla_protocol::messages::ObjectFields::from_pairs(&[(
                22,
                want.3.max(0.0) as u32,
            )]));
    }
    for (id, ally, pos, _, display, scale, weapons, sheath, class) in wanted {
        if seen.contains(&(id, ally)) {
            continue;
        }
        let entity = units::spawn_unit(
            &mut commands,
            &units::UnitSpec {
                serial: (if ally { 0x10000000 } else { 0x20000000 }) + id as u64,
                display,
                scale,
                level: 60,
                faction: if ally {
                    units::FACTION_FRIENDLY
                } else {
                    units::FACTION_MONSTER
                },
                bytes0: 1 | (u32::from(class) << 8),
                weapons,
                sheath,
            },
            position(pos, &world),
            0.0,
        );
        commands.entity(entity).insert(Body(id, ally));
    }
    // Only rebuild effect meshes on an authoritative update, not every render frame.
    if view.is_changed() {
        for entity in &telegraphs {
            commands.entity(entity).despawn();
        }
        for h in &view.state.hazards {
            commands.spawn((
                Telegraph,
                Mesh3d(meshes.add(Torus::new((h.radius - 0.12).max(0.1), h.radius))),
                MeshMaterial3d(materials.add(StandardMaterial {
                    base_color: Color::srgb(1.0, 0.35, 0.15),
                    unlit: true,
                    ..default()
                })),
                Transform::from_translation(position(h.pos, &world) + Vec3::Y * 0.12),
            ));
        }
    }
}
fn camera(
    view: Res<View>,
    world: WorldPoint,
    mut player: ResMut<crate::player::Player>,
    mut cams: Query<(&Camera, &mut Transform), With<WorldCamera>>,
    bodies: Query<
        (&Body, &Transform, Option<&crate::entities::VisualAttached>),
        Without<WorldCamera>,
    >,
    progress: Res<benilla_world::terrain_stream::WorldLoadProgress>,
    loading: Res<crate::loading_screen::LoadingScreen>,
) {
    let focus = view
        .state
        .players
        .iter()
        .find(|p| p.id == view.local)
        .map(|p| position(p.pos, &world))
        .unwrap_or_else(origin);
    player.active = true;
    player.detached = false;
    player.settling = false;
    player.world_stale = false;
    player.pos = focus;
    for (camera, mut tf) in &mut cams {
        *tf = Transform::from_translation(focus + Vec3::new(0.0, 36.0, 20.0))
            .looking_at(focus, Vec3::Y);
        let plates = js_sys::Object::new();
        for (body, position, _) in &bodies {
            if !body.1 {
                continue;
            }
            if let Ok(point) = camera.world_to_viewport(
                &GlobalTransform::from(*tf),
                position.translation + Vec3::Y * 2.5,
            ) {
                let coords = js_sys::Array::new();
                coords.push(&JsValue::from_f64(point.x as f64));
                coords.push(&JsValue::from_f64(point.y as f64));
                let _ = js_sys::Reflect::set(&plates, &body.0.to_string().into(), &coords);
            }
        }
        if let Some(parent) = parent() {
            let _ = js_sys::Reflect::set(&parent, &"__azeroth_coop_plates".into(), &plates);
            let models_ready = !view.state.players.is_empty()
                && view.state.players.iter().filter(|p| p.connected).all(|p| {
                    bodies
                        .iter()
                        .any(|(body, _, visual)| body.1 && body.0 == p.id && visual.is_some())
                });
            let ready = progress.presentable() && !loading.covering() && models_ready;
            let _ = js_sys::Reflect::set(&parent, &"__azeroth_coop_ready".into(), &ready.into());
            let _ = js_sys::Reflect::set(
                &parent,
                &"__azeroth_coop_loading".into(),
                &JsValue::from_f64(progress.fraction() as f64),
            );
        }
    }
}

fn visuals(
    mut commands: Commands,
    view: Res<View>,
    world: WorldPoint,
    bodies: Query<(Entity, &Body, &Transform)>,
    pickups: Query<(Entity, &Pickup)>,
    mut last_effect: Local<(u32, u32)>,
    mut fx: units::Fx,
) {
    if !view.is_changed() {
        return;
    }
    if view.state.phase == "lobby" || last_effect.0 != view.local {
        *last_effect = (view.local, 0);
    }
    let slot = view.state.players.iter().position(|p| p.id == view.local);
    let gems: Vec<_> = view
        .state
        .gems
        .iter()
        .filter(|g| {
            view.state.phase == "playing" && slot.is_some_and(|i| g.collected & (1 << i) == 0)
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    for (entity, gem) in &pickups {
        if gems.iter().any(|g| g.id == gem.0) {
            seen.insert(gem.0);
        } else {
            commands.entity(entity).despawn();
        }
    }
    for gem in gems {
        if seen.contains(&gem.id) {
            continue;
        }
        let entity = units::spawn_object(
            &mut commands,
            0x30000000 + gem.id as u64,
            426,
            1.0,
            position(gem.pos, &world) + Vec3::Y * 0.5,
        );
        commands.entity(entity).insert(Pickup(gem.id));
    }
    for effect in &view.state.effects {
        if effect.id <= last_effect.1 {
            continue;
        }
        let from = position(effect.from, &world);
        let to = position(effect.to, &world);
        let caster = bodies
            .iter()
            .filter(|(_, b, _)| b.1)
            .min_by(|(_, _, a), (_, _, b)| {
                a.translation
                    .distance_squared(from)
                    .total_cmp(&b.translation.distance_squared(from))
            });
        let Some((caster, _, _)) = caster else {
            continue;
        };
        let healing = effect.kind == "heal";
        let target =
            bodies
                .iter()
                .filter(|(_, b, _)| b.1 == healing)
                .min_by(|(_, _, a), (_, _, b)| {
                    a.translation
                        .distance_squared(to)
                        .total_cmp(&b.translation.distance_squared(to))
                });
        let hits: Vec<_> = target.map(|(entity, _, _)| entity).into_iter().collect();
        let spell = match effect.kind.as_str() {
            "heal" => 331,
            "frost" => 116,
            "cleave" => 845,
            "nova" => 122,
            "guard" => 1161,
            _ => 403,
        };
        fx.cast(caster, spell, &hits, Some(to));
    }
    if let Some(id) = view.state.effects.iter().map(|e| e.id).max() {
        last_effect.1 = last_effect.1.max(id);
    }
}

fn reap(
    mut commands: Commands,
    time: Res<Time>,
    view: Res<View>,
    mut corpses: Query<(Entity, &mut Corpse)>,
) {
    for (entity, mut corpse) in &mut corpses {
        corpse.0 -= time.delta_secs();
        if corpse.0 <= 0.0 || view.state.phase == "lobby" {
            commands.entity(entity).despawn();
        }
    }
}

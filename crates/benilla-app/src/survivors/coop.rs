//! Co-op, minimal: two players, each simulating only their own member and replicating its
//! transform. No authority yet — that is P4 (`docs/COOP-PLAN.md` §11.1), and until it lands both
//! peers run their own enemy simulation, so they see the same *players* and different *hordes*.
//! That is the deliberate stopping point of P3: "two players connect, move, and see each other".
//!
//! **The split.** The page owns the lobby and the wire (`web/lobby.js` over `web/net.js`): buttons,
//! join codes, the clipboard, `RTCPeerConnection`. The wasm owns the game. They meet at
//! `window.__wenilla_net`, read with the same once-a-frame `Reflect::get` idiom
//! `webbridge/sink.rs` uses for `window.__wenilla_bridge` — no new exports, no serde, no
//! command plumbing. This module reads exactly three things off that object and calls one method:
//!
//!   `role`      `'host' | 'guest' | null` — which side of the session the page negotiated
//!   `inbox`     an array of messages the page received; drained and cleared here each frame
//!   `sendFast`  called with one plain object per outgoing snapshot (unreliable channel)
//!
//! **Identity.** The host is always [`HOST`] (0). A guest takes 1. That is enough for two players
//! and deliberately not enough for five — assigning ids to 3-5 joiners is the host's job and
//! belongs with P5, where the party actually has to be tracked.
//!
//! **The wire**, one message kind so far, sent by both sides about their own member:
//!
//!   `{t:'p', id, x, y, z, yaw, hp, lv, cls, disp, race, sex, map}`
//!
//! Positions are Bevy world coordinates (both peers run the same engine over the same terrain, so
//! there is nothing to convert), and `disp` is the sender's `CreatureDisplayInfo` id so the far
//! side can build the same body without knowing the sender's class table.

use bevy::prelude::*;

use crate::creature_anim::{move_flags, MovementState};

use super::hero::{Hero, LocalPlayer};
use super::units::{self, Marks, UnitSpec};
use super::{data, Run, Selection, Wave};

/// A player's identity in the party. The host is always [`HOST`].
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub(super) struct OwnerId(pub u8);

/// The player who runs the session — and, from P4, the simulation.
pub(super) const HOST: OwnerId = OwnerId(0);

/// The id a joiner takes. Two players only; P5 assigns the rest from the host.
pub(super) const GUEST: OwnerId = OwnerId(1);

impl Default for OwnerId {
    fn default() -> Self {
        HOST
    }
}

/// A party member that is **not** this client's own — a peer's body, driven entirely by the wire.
/// The local member is marked [`LocalPlayer`] instead, so `With<PartyMember>` always means
/// "somebody else" and never needs filtering further.
#[derive(Component)]
pub(super) struct PartyMember {
    pub owner: OwnerId,
}

/// Which side of a session this client is on, as the page negotiated it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(super) enum Mode {
    #[default]
    Off,
    Host,
    Guest,
}

/// One peer's member, as the wire last reported it.
#[derive(Clone, Copy, Debug)]
pub(super) struct PeerState {
    pub owner: OwnerId,
    pub pos: Vec3,
    pub yaw: f32,
    pub hp: f32,
    pub level: u32,
    pub class: u8,
    pub display: u32,
    pub race: u8,
    pub sex: u8,
    pub map: u32,
}

/// The session: what the page negotiated, what arrived, and what we owe it back.
#[derive(Resource, Default)]
pub(super) struct Coop {
    mode: Mode,
    /// The newest state per peer, refreshed every frame from the page's inbox.
    peers: Vec<PeerState>,
    /// Our own identity, fixed by [`Mode`].
    me: OwnerId,
    /// Seconds until the next outgoing snapshot; snapshots go at [`SEND_HZ`], not per frame.
    send_t: f32,
    /// The battleground the host is on, so a joiner can follow it rather than stand in a
    /// different zone seeing bodies float over the wrong terrain.
    host_map: Option<usize>,
    /// Counters for the log line, so a session's health is visible without a debugger.
    sent: u64,
    recv: u64,
}

impl Coop {
    pub(super) fn mode(&self) -> Mode {
        self.mode
    }

    pub(super) fn me(&self) -> OwnerId {
        self.me
    }

    /// Is a session up (either side)? Everything co-op is inert until it is.
    pub(super) fn live(&self) -> bool {
        self.mode != Mode::Off
    }
}

/// Snapshots per second. Enough for smooth movement at a walking pace, few enough that the
/// unreliable channel is never the bottleneck.
const SEND_HZ: f32 = 20.0;

pub(crate) use imp::{drain_inbox, read_mode, send_fast};

/// The JavaScript boundary — the only place in this module that names `js_sys`/`web_sys`, in the
/// `webbridge/sink.rs` pattern: a wasm arm that talks to `window.__wenilla_net`, and a native arm
/// with the same signatures that answers "no page", so every call site type-checks on x86 where
/// the browser build cannot be compiled. Every JS result is discarded: a page handler that throws
/// must never take the client down.
#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;
    use js_sys::{Array, Function, Object, Reflect};
    use wasm_bindgen::{JsCast, JsValue};

    /// The page's handle, created by `web/net.js`.
    const HOOK: &str = "__wenilla_net";

    fn hook() -> Option<Object> {
        let window = web_sys::window()?;
        Reflect::get(&window, &HOOK.into())
            .ok()?
            .dyn_into::<Object>()
            .ok()
    }

    fn get(obj: &Object, key: &str) -> JsValue {
        Reflect::get(obj, &key.into()).unwrap_or(JsValue::UNDEFINED)
    }

    fn num(obj: &Object, key: &str) -> f64 {
        get(obj, key).as_f64().unwrap_or(0.0)
    }

    /// Which side of a session the page negotiated. Absent object, absent `role`, or a role we
    /// do not know all read as [`Mode::Off`] — single-player, exactly as before this module.
    pub(crate) fn read_mode() -> Mode {
        let Some(h) = hook() else { return Mode::Off };
        match get(&h, "role").as_string().as_deref() {
            Some("host") => Mode::Host,
            Some("guest") => Mode::Guest,
            _ => Mode::Off,
        }
    }

    /// Take every message off the page's inbox, leaving it empty (the same
    /// `set_length(0)` idiom the bridge uses on its command queue). An element this build does
    /// not understand is skipped, never fatal.
    pub(crate) fn drain_inbox() -> Vec<PeerState> {
        let Some(h) = hook() else { return Vec::new() };
        let Ok(inbox) = get(&h, "inbox").dyn_into::<Array>() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for value in inbox.iter() {
            let Ok(obj) = value.dyn_into::<Object>() else {
                continue;
            };
            // Only one message kind so far; anything else is a newer page talking to an older
            // build, and dropping it is the honest answer.
            if get(&obj, "t").as_string().as_deref() != Some("p") {
                continue;
            }
            out.push(PeerState {
                owner: OwnerId(num(&obj, "id").clamp(0.0, 255.0) as u8),
                pos: Vec3::new(
                    num(&obj, "x") as f32,
                    num(&obj, "y") as f32,
                    num(&obj, "z") as f32,
                ),
                yaw: num(&obj, "yaw") as f32,
                hp: num(&obj, "hp") as f32,
                level: num(&obj, "lv").max(0.0) as u32,
                class: num(&obj, "cls").clamp(0.0, 255.0) as u8,
                display: num(&obj, "disp").max(0.0) as u32,
                race: num(&obj, "race").clamp(0.0, 255.0) as u8,
                sex: num(&obj, "sex").clamp(0.0, 255.0) as u8,
                map: num(&obj, "map").max(0.0) as u32,
            });
        }
        inbox.set_length(0);
        out
    }

    /// One snapshot out, on the unreliable channel — it is overwritten by the next one, so
    /// retransmitting a stale position would be worse than losing it.
    pub(crate) fn send_fast(state: &PeerState, me: OwnerId) {
        let Some(h) = hook() else { return };
        let Some(f) = get(&h, "sendFast").dyn_into::<Function>().ok() else {
            return;
        };
        let obj = Object::new();
        let set = |key: &str, value: JsValue| {
            let _ = Reflect::set(&obj, &key.into(), &value);
        };
        set("t", JsValue::from_str("p"));
        set("id", JsValue::from_f64(f64::from(me.0)));
        set("x", JsValue::from_f64(f64::from(state.pos.x)));
        set("y", JsValue::from_f64(f64::from(state.pos.y)));
        set("z", JsValue::from_f64(f64::from(state.pos.z)));
        set("yaw", JsValue::from_f64(f64::from(state.yaw)));
        set("hp", JsValue::from_f64(f64::from(state.hp)));
        set("lv", JsValue::from_f64(f64::from(state.level)));
        set("cls", JsValue::from_f64(f64::from(state.class)));
        set("disp", JsValue::from_f64(f64::from(state.display)));
        set("race", JsValue::from_f64(f64::from(state.race)));
        set("sex", JsValue::from_f64(f64::from(state.sex)));
        set("map", JsValue::from_f64(f64::from(state.map)));
        let _ = f.call1(&JsValue::NULL, &obj);
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use super::*;

    /// Native: there is no page, so there is never a session. The whole module is inert here —
    /// which is what keeps `cargo check --workspace` honest on x86.
    pub(crate) fn read_mode() -> Mode {
        Mode::Off
    }

    pub(crate) fn drain_inbox() -> Vec<PeerState> {
        Vec::new()
    }

    pub(crate) fn send_fast(_state: &PeerState, _me: OwnerId) {}
}

// ---------------------------------------------------------------------------------------------
// The systems

/// Read which side of a session the page negotiated. One `Reflect::get` a frame, and it has to be
/// cheap because the player can host or join at any moment from the lobby.
pub(super) fn sync_mode(mut coop: ResMut<Coop>) {
    let mode = read_mode();
    if coop.mode == mode {
        return;
    }
    coop.mode = mode;
    coop.me = match mode {
        Mode::Guest => GUEST,
        _ => HOST,
    };
    if mode == Mode::Off {
        coop.peers.clear();
        coop.host_map = None;
    }
    info!("survivors coop: session {mode:?} as {:?}", coop.me);
}

/// Take what arrived, bring up a body for any peer not seen before, and move the bodies we have.
/// This is the whole of "see each other": no authority, no interpolation — the newest snapshot
/// wins, which at [`SEND_HZ`] reads smooth enough for a first playable.
pub(super) fn receive(
    mut commands: Commands,
    time: Res<Time>,
    mut coop: ResMut<Coop>,
    mut wave: ResMut<Wave>,
    mut selection: ResMut<Selection>,
    mut members: Query<(Entity, &PartyMember, &mut Transform, &mut MovementState)>,
) {
    if !coop.live() {
        return;
    }
    let incoming = drain_inbox();
    if incoming.is_empty() {
        return;
    }
    coop.recv += incoming.len() as u64;
    for state in incoming {
        // Our own snapshot, relayed back to us: never ours to apply.
        if state.owner == coop.me {
            continue;
        }
        match coop.peers.iter_mut().find(|p| p.owner == state.owner) {
            Some(slot) => *slot = state,
            None => {
                info!(
                    "survivors coop: peer {:?} joined (class {}, display {})",
                    state.owner, state.class, state.display
                );
                coop.peers.push(state);
            }
        }
    }

    // A joiner stands where the host stands: follow the host's battleground rather than float
    // over the wrong terrain. Both peers index the same `data::MAPS`, so the index is the message.
    if coop.mode == Mode::Guest {
        if let Some(&host) = coop.peers.first() {
            let want = (host.map as usize).min(data::MAPS.len() - 1);
            if selection.stage != want {
                selection.stage = want;
                selection.map = want;
            }
        }
    }

    let dt = time.delta_secs().max(1e-4);
    for state in &coop.peers {
        let Some((_, _, mut tf, mut mv)) = members
            .iter_mut()
            .find(|(_, m, _, _)| m.owner == state.owner)
        else {
            continue;
        };
        // The walk animation is driven by distance actually covered, not by the wire, so a peer
        // standing still stands still.
        let moved = (state.pos - tf.translation).length();
        tf.translation = state.pos;
        tf.rotation = Quat::from_rotation_y(state.yaw);
        mv.speed = moved / dt;
        mv.flags = if moved > 0.001 {
            move_flags::FORWARD
        } else {
            0
        };
    }

    // A body per peer we have not built yet.
    for state in &coop.peers {
        if members.iter().any(|(_, m, _, _)| m.owner == state.owner) {
            continue;
        }
        let class = class_of(state.class);
        let bytes0 = u32::from(state.race)
            | u32::from(state.class) << 8
            | u32::from(state.sex) << 16
            | u32::from(class.power) << 24;
        let e = units::spawn_unit(
            &mut commands,
            &UnitSpec {
                serial: wave.guid(),
                display: state.display,
                scale: 1.0,
                level: 60,
                faction: units::FACTION_FRIENDLY,
                bytes0,
                weapons: class.weapons,
                sheath: class.sheath,
            },
            state.pos,
            state.yaw,
        );
        // `Hero` too, not just `PartyMember`: it is the marker every party-wide query and every
        // `Without<Hero>` exclusion already keys off, so a peer is a member to the enemies, the
        // gems and the minimap without a line of new filtering.
        commands.entity(e).insert((
            PartyMember { owner: state.owner },
            Hero { vy: 0.0, air: 0.0 },
            Marks::buffs(),
        ));
    }
}

/// Send our own member's state, on a timer rather than per frame.
pub(super) fn send_self(
    time: Res<Time>,
    mut coop: ResMut<Coop>,
    selection: Res<Selection>,
    run: Res<Run>,
    hero: Query<&Transform, With<LocalPlayer>>,
) {
    if !coop.live() {
        return;
    }
    coop.send_t -= time.delta_secs();
    if coop.send_t > 0.0 {
        return;
    }
    coop.send_t = 1.0 / SEND_HZ;
    let Ok(tf) = hero.single() else { return };
    // The look the pick screen chose: the far side renders the same model without knowing our
    // class table, which is what `disp` is for.
    let (display, race, sex) = selection
        .look
        .and_then(|i| selection.looks.get(i))
        .copied()
        .unwrap_or((0, run.race, 0));
    let state = PeerState {
        owner: coop.me,
        pos: tf.translation,
        yaw: tf.rotation.to_euler(EulerRot::YXZ).0,
        hp: run.hp,
        level: run.level,
        class: run.class.id,
        display,
        race,
        sex,
        map: selection.map as u32,
    };
    send_fast(&state, coop.me);
    coop.sent += 1;
}

/// The class row a peer's class id names, for its weapons and sheath. An id this build does not
/// know falls back to the first class rather than refusing to draw the body at all.
fn class_of(id: u8) -> &'static data::ClassDef {
    data::CLASSES
        .iter()
        .find(|c| c.id == id)
        .unwrap_or(&data::CLASSES[0])
}

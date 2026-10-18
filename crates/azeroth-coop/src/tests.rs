use super::*;
fn party(builds: &[&str]) -> Engine {
    let mut engine = Engine::new(42);
    for (i, build) in builds.iter().enumerate() {
        assert!(engine.join(i as u32 + 1, &format!("Player{i}"), build));
    }
    assert!(engine.start());
    engine
}
#[test]
fn capacity_identity_and_intent_boundary() {
    let mut e = Engine::new(1);
    for id in 1..=5 {
        assert!(e.join(id, "Friend", "frost"));
    }
    assert!(!e.join(6, "Extra", "frost"));
    assert!(!e.join(1, "Duplicate", "protection"));
    e.start();
    assert!(!e.command(99, r#"{"kind":"ability"}"#));
    assert!(!e.command(1, r#"{"kind":"move","x":2,"y":0}"#));
    assert!(!e.command(1, r#"{"kind":"move","x":1e99,"y":0}"#));
    assert!(!e.command(1, r#"{"kind":"move","x":1,"y":0,"hp":999}"#));
    assert!(!e.command(1, r#"{"kind":"upgrade","choice":0}"#));
    assert!(!e.command(1, r#"{"kind":"talent","tier":1,"choice":1}"#));
    assert!(!e.join(7, "Late", "frost"));
}
#[test]
fn normalized_movement_expires_and_stays_in_arena() {
    let mut e = party(&["protection"]);
    e.command(1, r#"{"kind":"move","x":1,"y":1}"#);
    e.step();
    assert!((e.world.players[0].pos.distance(Point::default()) - 7.0 * STEP).abs() < 0.001);
    for _ in 0..30 {
        e.step();
    }
    let stopped = e.world.players[0].pos;
    for _ in 0..30 {
        e.step();
    }
    assert_eq!(e.world.players[0].pos.x, stopped.x);
    e.world.players[0].pos = Point { x: LIMIT, y: LIMIT };
    e.command(1, r#"{"kind":"move","x":1,"y":1}"#);
    e.step();
    assert_eq!(e.world.players[0].pos.x, LIMIT);
}
#[test]
fn threat_taunt_death_and_disconnect_fallback() {
    let mut e = party(&["protection", "frost", "restoration"]);
    e.spawn(false);
    e.world.enemies[0].hp = 1000.0;
    e.world.enemies[0].pos = Point { x: 4.0, y: 0.0 };
    e.hit(0, 1, 2.0);
    e.enemies();
    assert_eq!(e.world.enemies[0].target, 2);
    e.active(0);
    e.enemies();
    assert_eq!(e.world.enemies[0].target, 1);
    e.world.players[0].hp = 0.0;
    e.enemies();
    assert_ne!(e.world.enemies[0].target, 1);
    e.leave(2);
    e.enemies();
    assert_eq!(e.world.enemies[0].target, 3);
}
#[test]
fn healing_targets_injured_allies_and_generates_threat() {
    let mut e = party(&["protection", "restoration", "frost"]);
    e.world.players[0].hp = 30.0;
    e.world.players[2].hp = 80.0;
    e.spawn(false);
    e.world.enemies[0].pos = Point::default();
    e.heal(1, false);
    assert!(e.world.players[0].hp > 30.0);
    assert_eq!(e.world.players[2].hp, 80.0);
    assert!(e.world.enemies[0].threat[1] > 0.0);
    e.heal(1, true);
    assert!(e.world.players[2].hp > 80.0);
    assert!(e.world.players[0].shield > 0.0);
    e.world.players[2].hp = 0.0;
    e.heal(1, true);
    assert_eq!(e.world.players[2].hp, 0.0);
}
#[test]
fn per_player_xp_choices_do_not_pause_or_steal() {
    let mut e = party(&["frost", "fury"]);
    e.world.players[1].pos.x = 20.0;
    e.world.gems.push(Gem {
        id: 1,
        pos: Point::default(),
        xp: 10.0,
        collected: 0,
    });
    e.loot();
    assert_eq!(e.world.players[0].level, 3);
    assert_eq!(e.world.players[1].level, 1);
    assert_eq!(e.world.phase, "playing");
    assert!(e.command(1, r#"{"kind":"upgrade","choice":0}"#));
    assert_eq!(e.world.players[0].upgrades[0], 1);
    assert_eq!(e.world.players[1].upgrades[0], 0);
    e.world.players[1].pos.x = 0.0;
    e.loot();
    assert_eq!(e.world.players[1].level, 3);
    assert!(e.world.gems.is_empty());
    let elapsed = e.world.elapsed;
    e.step();
    assert!(e.world.elapsed > elapsed);
}
#[test]
fn mitigation_shields_revive_and_talent_prerequisites() {
    let mut e = party(&["protection", "restoration"]);
    let before = e.world.players[0].hp;
    e.world.players[0].hurt(100.0);
    assert!((before - e.world.players[0].hp - 65.0).abs() < 0.01);
    e.world.players[0].shield = 20.0;
    e.world.players[0].guard = 5.0;
    let before = e.world.players[0].hp;
    e.world.players[0].hurt(100.0);
    assert!((before - e.world.players[0].hp - 5.0).abs() < 0.01);
    assert!(e.command(1, r#"{"kind":"talent","tier":0,"choice":2}"#));
    assert!(!e.command(1, r#"{"kind":"talent","tier":0,"choice":1}"#));
    e.world.players[0].level = 5;
    assert!(e.command(1, r#"{"kind":"talent","tier":1,"choice":2}"#));
    e.world.players[0].hp = 0.0;
    e.world.players[0].pending = 1;
    e.command(1, r#"{"kind":"upgrade","choice":3}"#);
    assert_eq!(e.world.players[0].hp, 0.0);
    for _ in 0..122 {
        e.revive();
    }
    assert!(e.world.players[0].hp > 0.0);
}
#[test]
fn telegraphs_lock_before_impact_and_defeat_resets_cleanly() {
    let mut e = party(&["frost"]);
    e.world.hazards.push(Hazard {
        pos: Point::default(),
        radius: 4.0,
        left: STEP * 2.0,
        damage: 500.0,
    });
    e.step();
    assert!(e.world.players[0].hp > 0.0);
    e.step();
    assert_eq!(e.world.phase, "defeat");
    e.lobby();
    assert_eq!(e.world.phase, "lobby");
    assert_eq!(e.world.players[0].level, 1);
    assert!(e.world.enemies.is_empty());
    assert!(e.world.hazards.is_empty());
    assert!(e.start());
}
#[test]
fn snapshot_roundtrips_without_private_threat_or_input() {
    let mut e = party(&["frost"]);
    e.step();
    let json = e.snapshot();
    let state: World = serde_json::from_str(&json).unwrap();
    assert_eq!(state.players.len(), 1);
    assert_eq!(state.version, 1);
    assert!(!json.contains("threat"));
    assert!(!json.contains("input"));
}
#[test]
fn five_player_full_run_is_deterministic_and_bounded() {
    // Real commands only: move in a circle, dodge the horde, spend earned upgrades and use F.
    // This is a repeatable balance probe, not a claim of human or WAN playtesting.
    let specs = &["protection", "restoration", "elemental", "fury", "frost"];
    let first = exercise_run(specs, 0.15, 480);
    assert_eq!(first.world.phase, "victory");
    assert_eq!(first.snapshot(), exercise_run(specs, 0.15, 480).snapshot());
}

#[test]
fn saturated_partially_collected_loot_preserves_new_rewards() {
    let mut e = party(&["frost", "fury"]);
    for id in 0..180 {
        e.world.gems.push(Gem {
            id,
            pos: Point { x: 50.0, y: 50.0 },
            xp: 3.0,
            collected: 1,
        });
    }
    e.spawn(false);
    e.world.enemies[0].hp = 0.0;
    e.loot();
    assert_eq!(e.world.gems.len(), 180);
    assert_eq!(e.world.players[0].level, 2);
    assert_eq!(e.world.players[1].level, 2);
}

fn exercise_run(specs: &[&str], angular_speed: f32, seconds: usize) -> Engine {
    let mut e = party(specs);
    let mut peak_bytes = 0;
    for step in 0..(30 * seconds) {
        for i in 0..specs.len() {
            let p = &e.world.players[i];
            let t = step as f32 * STEP;
            let angle = t * angular_speed + i as f32 * 0.12;
            let dest = Point {
                x: angle.cos() * 19.0,
                y: angle.sin() * 19.0,
            };
            let d = p.pos.distance(dest).max(1.0);
            let command = format!(
                r#"{{"kind":"move","x":{},"y":{}}}"#,
                (dest.x - p.pos.x) / d,
                (dest.y - p.pos.y) / d
            );
            e.command(i as u32 + 1, &command);
            if step % 30 == 0 {
                e.command(i as u32 + 1, r#"{"kind":"ability"}"#);
                e.command(i as u32 + 1, r#"{"kind":"talent","tier":0,"choice":1}"#);
                e.command(i as u32 + 1, r#"{"kind":"talent","tier":1,"choice":1}"#);
                for choice in [0, 1, 2, 3, 5, 4] {
                    if e.command(
                        i as u32 + 1,
                        &format!(r#"{{"kind":"upgrade","choice":{choice}}}"#),
                    ) {
                        break;
                    }
                }
            }
        }
        e.step();
        assert!(e.world.enemies.len() <= MAX_ENEMIES + 3);
        assert!(e.world.gems.len() <= 180);
        assert!(e.world.effects.len() <= 80);
        if step % 30 == 0 {
            peak_bytes = peak_bytes.max(e.snapshot().len());
        }
        if e.world.phase != "playing" {
            break;
        }
    }
    eprintln!(
        "full-run: {} at {:.1}s, {} kills, {}/3 bosses, max snapshot {} bytes",
        e.world.phase, e.world.elapsed, e.world.kills, e.world.bosses_killed, peak_bytes
    );
    assert!(peak_bytes < 192 * 1024);
    e
}

#[test]
fn solo_progression_reaches_and_defeats_first_boss() {
    let run = exercise_run(&["frost"], 0.30, 300);
    assert_eq!(run.world.phase, "playing");
    assert!(run.world.bosses_killed >= 1);
    assert!(run.world.players[0].level > 1);
    assert!(run.world.players[0].upgrades.iter().any(|rank| *rank > 0));
}
#[test]
fn two_player_full_run_completes() {
    let run = exercise_run(&["frost", "restoration"], 0.30, 900);
    assert_eq!(run.world.phase, "victory");
}

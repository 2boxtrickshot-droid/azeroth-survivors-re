//! Host-only survival simulation. Clients submit intent, never positions or combat results.
//! Existing solo content stays authoritative for class identity, creature looks and XP curve.
#[allow(dead_code)]
#[path = "../../benilla-app/src/survivors/data.rs"]
mod content;

use serde::{Deserialize, Serialize};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub const STEP: f32 = 1.0 / 30.0;
pub const LIMIT: f32 = 65.0;
pub const RUN_SECONDS: f32 = 360.0;
pub const MAX_ENEMIES: usize = 220;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}
impl Point {
    fn distance(self, other: Self) -> f32 {
        (self.x - other.x).hypot(self.y - other.y)
    }
    fn approach(&mut self, to: Self, step: f32) {
        let d = self.distance(to).max(0.001);
        self.x += (to.x - self.x) / d * step.min(d);
        self.y += (to.y - self.y) / d * step.min(d);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Build {
    Protection,
    Fury,
    Restoration,
    Elemental,
    Enhancement,
    Frost,
}
impl Build {
    pub fn class(self) -> u8 {
        match self {
            Self::Protection | Self::Fury => 1,
            Self::Restoration | Self::Elemental | Self::Enhancement => 7,
            Self::Frost => 8,
        }
    }
    fn melee(self) -> bool {
        matches!(self, Self::Protection | Self::Fury | Self::Enhancement)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Player {
    pub id: u32,
    pub name: String,
    pub build: Build,
    pub pos: Point,
    pub hp: f32,
    pub max_hp: f32,
    pub resource: f32,
    pub shield: f32,
    pub level: u32,
    pub xp: f32,
    pub next_xp: f32,
    pub pending: u32,
    pub upgrades: [u8; 6],
    /// 0 is undecided; 1 or 2 selects one mutually exclusive branch per tier.
    pub talents: [u8; 2],
    pub cooldown: f32,
    pub connected: bool,
    pub damage: f32,
    pub healing: f32,
    pub revive: f32,
    #[serde(skip)]
    input: Point,
    #[serde(skip)]
    input_age: f32,
    #[serde(skip)]
    attack_cd: f32,
    #[serde(skip)]
    support_cd: f32,
    #[serde(skip)]
    guard: f32,
}
impl Player {
    fn new(id: u32, name: String, build: Build, slot: usize) -> Self {
        let max_hp = if build.melee() { 160.0 } else { 120.0 };
        Self {
            id,
            name,
            build,
            pos: Point {
                x: slot as f32 * 2.0,
                y: 0.0,
            },
            hp: max_hp,
            max_hp,
            resource: 100.0,
            shield: 0.0,
            level: 1,
            xp: 0.0,
            next_xp: content::xp_to_next(1),
            pending: 0,
            upgrades: [0; 6],
            talents: [0; 2],
            cooldown: 0.0,
            connected: true,
            damage: 0.0,
            healing: 0.0,
            revive: 0.0,
            input: Point::default(),
            input_age: 0.0,
            attack_cd: 0.0,
            support_cd: 0.0,
            guard: 0.0,
        }
    }
    fn alive(&self) -> bool {
        self.connected && self.hp > 0.0
    }
    fn power(&self) -> f32 {
        1.0 + self.upgrades[0] as f32 * 0.22
    }
    fn haste(&self) -> f32 {
        1.0 + self.upgrades[1] as f32 * 0.14
    }
    fn area(&self) -> f32 {
        1.0 + self.upgrades[2] as f32 * 0.16
    }
    fn hurt(&mut self, raw: f32) {
        if !self.alive() {
            return;
        }
        let mitigation = if self.build == Build::Protection {
            0.35
        } else {
            0.0
        } + if self.guard > 0.0 { 0.4 } else { 0.0 }
            + if self.talents[0] == 2 { 0.1 } else { 0.0 };
        let dmg = raw * (1.0 - mitigation);
        let absorbed = self.shield.min(dmg);
        self.shield -= absorbed;
        self.hp = (self.hp - dmg + absorbed).max(0.0);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Enemy {
    pub id: u32,
    pub kind: u8,
    pub name: String,
    pub display: u32,
    pub pos: Point,
    pub hp: f32,
    pub max_hp: f32,
    pub boss: bool,
    pub elite: bool,
    pub target: u32,
    pub slow: f32,
    #[serde(skip)]
    threat: [f32; 5],
    #[serde(skip)]
    taunt: Option<(u32, f32)>,
    #[serde(skip)]
    attack_cd: f32,
    #[serde(skip)]
    special_cd: f32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Gem {
    pub id: u32,
    pub pos: Point,
    pub xp: f32,
    /// Each player can collect once; a teammate cannot steal your progression.
    pub collected: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Effect {
    pub id: u32,
    pub kind: String,
    pub from: Point,
    pub to: Point,
    pub radius: f32,
    pub left: f32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hazard {
    pub pos: Point,
    pub radius: f32,
    pub left: f32,
    pub damage: f32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct World {
    pub version: u8,
    pub tick: u32,
    pub phase: String,
    pub elapsed: f32,
    pub players: Vec<Player>,
    pub enemies: Vec<Enemy>,
    pub gems: Vec<Gem>,
    pub effects: Vec<Effect>,
    pub hazards: Vec<Hazard>,
    pub kills: u32,
    pub bosses_spawned: u8,
    pub bosses_killed: u8,
}
impl Default for World {
    fn default() -> Self {
        Self {
            version: 1,
            tick: 0,
            phase: "lobby".into(),
            elapsed: 0.0,
            players: vec![],
            enemies: vec![],
            gems: vec![],
            effects: vec![],
            hazards: vec![],
            kills: 0,
            bosses_spawned: 0,
            bosses_killed: 0,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Move { x: f32, y: f32 },
    Ability,
    Upgrade { choice: usize },
    Talent { tier: usize, choice: u8 },
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct Engine {
    world: World,
    rng: u32,
    serial: u32,
    spawn_cd: f32,
}
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl Engine {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(seed: u32) -> Self {
        Self {
            world: World::default(),
            rng: seed.max(1),
            serial: 100,
            spawn_cd: 0.0,
        }
    }
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&self.world).expect("bounded finite simulation")
    }
    pub fn join(&mut self, id: u32, name: &str, build: &str) -> bool {
        if self.world.phase != "lobby"
            || id == 0
            || self.world.players.len() >= 5
            || self.world.players.iter().any(|p| p.id == id)
        {
            return false;
        }
        let Ok(build) = serde_json::from_value::<Build>(serde_json::Value::String(build.into()))
        else {
            return false;
        };
        let name: String = name.chars().filter(|c| !c.is_control()).take(20).collect();
        if name.trim().is_empty() {
            return false;
        }
        self.world
            .players
            .push(Player::new(id, name, build, self.world.players.len()));
        true
    }
    pub fn leave(&mut self, id: u32) {
        if self.world.phase == "lobby" {
            self.world.players.retain(|p| p.id != id);
        } else if let Some(p) = self.world.players.iter_mut().find(|p| p.id == id) {
            p.connected = false;
            p.input = Point::default();
        }
    }
    pub fn start(&mut self) -> bool {
        if self.world.phase != "lobby" || self.world.players.is_empty() {
            return false;
        }
        self.world.phase = "playing".into();
        true
    }
    pub fn lobby(&mut self) {
        let players: Vec<_> = self
            .world
            .players
            .iter()
            .filter(|p| p.connected)
            .enumerate()
            .map(|(i, p)| Player::new(p.id, p.name.clone(), p.build, i))
            .collect();
        self.world = World {
            players,
            ..World::default()
        };
        self.spawn_cd = 0.0;
    }
    pub fn command(&mut self, id: u32, json: &str) -> bool {
        if json.len() > 256 {
            return false;
        }
        let Ok(command) = serde_json::from_str::<Command>(json) else {
            return false;
        };
        let Some(i) = self
            .world
            .players
            .iter()
            .position(|p| p.id == id && p.connected)
        else {
            return false;
        };
        if let Command::Talent { tier, choice } = command {
            let p = &mut self.world.players[i];
            if tier > 1
                || !(1..=2).contains(&choice)
                || p.talents[tier] != 0
                || (tier == 1 && (p.level < 5 || p.talents[0] == 0))
            {
                return false;
            }
            p.talents[tier] = choice;
            return true;
        }
        if self.world.phase != "playing" {
            return false;
        }
        let p = &mut self.world.players[i];
        match command {
            Command::Move { x, y }
                if x.is_finite() && y.is_finite() && x.abs() <= 1.0 && y.abs() <= 1.0 =>
            {
                let len = x.hypot(y).max(1.0);
                p.input = Point {
                    x: x / len,
                    y: y / len,
                };
                p.input_age = 0.0;
            }
            Command::Upgrade { choice }
                if choice < 6 && p.pending > 0 && p.upgrades[choice] < 8 =>
            {
                p.pending -= 1;
                p.upgrades[choice] += 1;
                if choice == 3 {
                    p.max_hp += 20.0;
                    if p.hp > 0.0 {
                        p.hp = (p.hp + 20.0).min(p.max_hp);
                    }
                }
            }
            Command::Ability if p.alive() && p.cooldown <= 0.0 && p.resource >= 30.0 => {
                p.resource -= 30.0;
                p.cooldown = if p.talents[1] == 2 { 8.0 } else { 12.0 };
                self.active(i);
            }
            _ => return false,
        }
        true
    }
    /// Exactly one fixed step. The host wall-clock driver bounds catch-up to avoid runaway work.
    pub fn step(&mut self) {
        self.world.tick += 1;
        if self.world.phase != "playing" {
            return;
        }
        self.world.elapsed += STEP;
        for p in &mut self.world.players {
            p.input_age += STEP;
            if p.input_age > 0.5 {
                p.input = Point::default();
            }
            p.cooldown = (p.cooldown - STEP).max(0.0);
            p.attack_cd -= STEP;
            p.support_cd -= STEP;
            p.guard = (p.guard - STEP).max(0.0);
            if !p.alive() {
                continue;
            }
            p.resource = (p.resource + STEP * 5.0).min(100.0);
            p.hp = (p.hp + STEP * (0.5 + p.upgrades[5] as f32 * 0.3)).min(p.max_hp);
            let speed = 7.0 * (1.0 + p.upgrades[4] as f32 * 0.07);
            p.pos.x = (p.pos.x + p.input.x * speed * STEP).clamp(-LIMIT, LIMIT);
            p.pos.y = (p.pos.y + p.input.y * speed * STEP).clamp(-LIMIT, LIMIT);
        }
        self.spawn_cd -= STEP;
        if self.spawn_cd <= 0.0 {
            let count = self.world.players.iter().filter(|p| p.connected).count();
            self.spawn_cd =
                (0.9 / (1.0 + self.world.elapsed / 90.0) / (1.0 + count as f32 * 0.3)).max(0.09);
            if self.world.enemies.len() < MAX_ENEMIES {
                self.spawn(false);
            }
        }
        if self.world.bosses_spawned < 3
            && self.world.elapsed >= 90.0 + self.world.bosses_spawned as f32 * 105.0
        {
            self.spawn(true);
            self.world.bosses_spawned += 1;
        }
        for i in 0..self.world.players.len() {
            if !self.world.players[i].alive() {
                continue;
            }
            self.attack(i);
            if self.world.players[i].build == Build::Restoration
                && self.world.players[i].support_cd <= 0.0
            {
                self.world.players[i].support_cd = 2.5 / self.world.players[i].haste();
                self.heal(i, false);
            }
        }
        self.enemies();
        self.loot();
        self.revive();
        for e in &mut self.world.effects {
            e.left -= STEP;
        }
        self.world.effects.retain(|e| e.left > 0.0);
        for h in &mut self.world.hazards {
            h.left -= STEP;
            if h.left <= 0.0 {
                for p in &mut self.world.players {
                    if p.pos.distance(h.pos) < h.radius {
                        p.hurt(h.damage);
                    }
                }
            }
        }
        self.world.hazards.retain(|h| h.left > 0.0);
        if !self.world.players.iter().any(Player::alive) {
            self.world.phase = "defeat".into();
        } else if self.world.elapsed >= RUN_SECONDS && self.world.bosses_killed == 3 {
            self.world.phase = "victory".into();
        }
    }
}

impl Engine {
    fn random(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        self.rng as f32 / u32::MAX as f32
    }
    fn id(&mut self) -> u32 {
        self.serial += 1;
        self.serial
    }
    fn effect(&mut self, kind: &str, from: Point, to: Point, radius: f32) {
        if self.world.effects.len() >= 80 {
            return;
        }
        let id = self.id();
        self.world.effects.push(Effect {
            id,
            kind: kind.into(),
            from,
            to,
            radius,
            left: 0.35,
        });
    }
    fn spawn(&mut self, boss: bool) {
        let alive: Vec<_> = self
            .world
            .players
            .iter()
            .filter(|p| p.alive())
            .map(|p| p.pos)
            .collect();
        if alive.is_empty() {
            return;
        }
        let center = alive[(self.random() * alive.len() as f32) as usize % alive.len()];
        let angle = self.random() * std::f32::consts::TAU;
        let pos = Point {
            x: (center.x + angle.cos() * 32.0).clamp(-LIMIT, LIMIT),
            y: (center.y + angle.sin() * 32.0).clamp(-LIMIT, LIMIT),
        };
        let tier = (self.world.elapsed / 60.0) as usize;
        let kind = if boss {
            3
        } else if self.world.elapsed > 45.0 {
            (self.random() * 3.0) as u8
        } else {
            0
        };
        let elite = !boss && self.random() < 0.06;
        let map = content::MAPS
            .iter()
            .position(|m| m.name == "Elwynn Forest")
            .unwrap_or(0);
        let roster = content::roster(map);
        let def = if boss {
            &roster.bosses[self.world.bosses_spawned as usize % roster.bosses.len()]
        } else {
            &roster.enemies[(tier * 2 + kind as usize).min(roster.enemies.len() - 1)]
        };
        let scale = 1.0 + (alive.len() - 1) as f32 * 0.55;
        let hp = if boss {
            (900.0 + self.world.bosses_spawned as f32 * 700.0) * scale
        } else {
            (20.0 + self.world.elapsed * 0.22) * scale * if elite { 3.0 } else { 1.0 }
        };
        let id = self.id();
        self.world.enemies.push(Enemy {
            id,
            kind,
            name: def.name.into(),
            display: def.display,
            pos,
            hp,
            max_hp: hp,
            boss,
            elite,
            target: 0,
            slow: 0.0,
            threat: [0.0; 5],
            taunt: None,
            attack_cd: 1.0,
            special_cd: if boss { 4.0 } else { 3.0 },
        });
    }
    fn hit(&mut self, enemy: usize, player: usize, damage: f32) {
        let p = &mut self.world.players[player];
        let e = &mut self.world.enemies[enemy];
        if e.hp <= 0.0 {
            return;
        }
        let dealt = damage.min(e.hp);
        e.hp -= dealt;
        e.threat[player] += dealt
            * if p.build == Build::Protection {
                4.0
            } else {
                1.0
            };
        p.damage += dealt;
        if p.build == Build::Frost {
            e.slow = 2.0;
        }
    }
    fn attack(&mut self, i: usize) {
        let p = &self.world.players[i];
        if p.attack_cd > 0.0 {
            return;
        }
        let reach = if p.build.melee() {
            5.0 * p.area()
        } else {
            24.0
        };
        let mut nearby: Vec<_> = self
            .world
            .enemies
            .iter()
            .enumerate()
            .filter(|(_, e)| e.hp > 0.0 && e.pos.distance(p.pos) < reach)
            .map(|(j, e)| (j, e.pos.distance(p.pos)))
            .collect();
        nearby.sort_by(|a, b| a.1.total_cmp(&b.1));
        if nearby.is_empty() {
            return;
        }
        let build = p.build;
        let pos = p.pos;
        let power = p.power()
            * if p.talents[0] == 1 { 1.2 } else { 1.0 }
            * if p.talents[1] == 1 { 1.25 } else { 1.0 };
        let damage = match build {
            Build::Protection => 15.0,
            Build::Fury => 28.0,
            Build::Restoration => 12.0,
            Build::Elemental => 22.0,
            Build::Enhancement => 32.0,
            Build::Frost => 24.0,
        } * power;
        let count = match build {
            Build::Protection | Build::Fury => 6,
            Build::Elemental => 3 + p.upgrades[2] as usize / 2,
            Build::Enhancement => 3,
            _ => 1,
        };
        self.world.players[i].attack_cd = 1.1 / p.haste();
        for &(j, _) in nearby.iter().take(count) {
            self.hit(j, i, damage);
            let to = self.world.enemies[j].pos;
            self.effect(
                if build.melee() {
                    "cleave"
                } else if build == Build::Frost {
                    "frost"
                } else {
                    "lightning"
                },
                pos,
                to,
                1.0,
            );
        }
    }
    fn active(&mut self, i: usize) {
        let p = &self.world.players[i];
        let pos = p.pos;
        let build = p.build;
        let radius = if build == Build::Protection {
            20.0
        } else {
            10.0
        } * p.area();
        let damage = 60.0 * p.power();
        if build == Build::Restoration {
            self.heal(i, true);
            return;
        }
        if build == Build::Protection {
            self.world.players[i].guard = 5.0;
        }
        for j in 0..self.world.enemies.len() {
            if self.world.enemies[j].pos.distance(pos) > radius {
                continue;
            }
            if build == Build::Protection {
                let e = &mut self.world.enemies[j];
                e.taunt = Some((self.world.players[i].id, 4.0));
                e.threat[i] = e.threat.iter().copied().fold(0.0, f32::max) + 100.0;
            }
            self.hit(
                j,
                i,
                if build == Build::Protection {
                    damage * 0.4
                } else {
                    damage
                },
            );
            self.world.enemies[j].slow = if build == Build::Frost { 4.0 } else { 1.0 };
        }
        self.effect(
            if build == Build::Protection {
                "guard"
            } else {
                "nova"
            },
            pos,
            pos,
            radius,
        );
    }
    fn heal(&mut self, i: usize, chain: bool) {
        let p = &self.world.players[i];
        let pos = p.pos;
        let amount = (if chain { 55.0 } else { 22.0 })
            * p.power()
            * (1.0 + p.upgrades[5] as f32 * 0.2)
            * if p.talents[0] == 1 { 1.2 } else { 1.0 };
        let mut targets: Vec<_> = self
            .world
            .players
            .iter()
            .enumerate()
            .filter(|(_, t)| t.alive() && t.pos.distance(pos) < 28.0 && t.hp < t.max_hp)
            .map(|(j, t)| (j, t.hp / t.max_hp))
            .collect();
        targets.sort_by(|a, b| a.1.total_cmp(&b.1));
        let mut total = 0.0;
        for (j, _) in targets.into_iter().take(if chain { 5 } else { 1 }) {
            let target = &mut self.world.players[j];
            let healed = amount.min(target.max_hp - target.hp);
            target.hp += healed;
            if chain {
                target.shield = (target.shield + amount * 0.4).min(60.0);
            }
            total += healed;
            let to = target.pos;
            self.effect("heal", pos, to, 1.0);
        }
        self.world.players[i].healing += total;
        for e in &mut self.world.enemies {
            if e.pos.distance(pos) < 35.0 {
                e.threat[i] += total * 0.3;
            }
        }
    }
    fn enemies(&mut self) {
        let elapsed = self.world.elapsed;
        for e in &mut self.world.enemies {
            if e.hp <= 0.0 {
                continue;
            }
            e.attack_cd -= STEP;
            e.special_cd -= STEP;
            e.slow = (e.slow - STEP).max(0.0);
            for t in &mut e.threat {
                *t *= 1.0 - STEP * 0.02;
            }
            if let Some((_, remaining)) = &mut e.taunt {
                *remaining -= STEP;
                if *remaining <= 0.0 {
                    e.taunt = None;
                }
            }
            let target = self
                .world
                .players
                .iter()
                .enumerate()
                .filter(|(_, p)| p.alive())
                .max_by(|(a, pa), (b, pb)| {
                    let taunted = |p: &Player| e.taunt.is_some_and(|(id, _)| id == p.id);
                    taunted(pa)
                        .cmp(&taunted(pb))
                        .then_with(|| e.threat[*a].total_cmp(&e.threat[*b]))
                        .then_with(|| e.pos.distance(pb.pos).total_cmp(&e.pos.distance(pa.pos)))
                })
                .map(|(i, _)| i);
            let Some(i) = target else {
                continue;
            };
            let p = &mut self.world.players[i];
            e.target = p.id;
            let dist = e.pos.distance(p.pos);
            let ranged = e.kind == 2 && !e.boss;
            let speed = (if e.boss {
                3.0
            } else if e.kind == 1 {
                6.0
            } else {
                3.8
            }) * if e.slow > 0.0 { 0.45 } else { 1.0 };
            if dist > if ranged { 13.0 } else { 1.6 } {
                e.pos.approach(p.pos, speed * STEP);
            }
            if e.boss && e.special_cd <= 0.0 {
                e.special_cd = 6.0;
                // Ground slam plus targeted circles; each locks before impact so players can dodge.
                self.world.hazards.push(Hazard {
                    pos: e.pos,
                    radius: 8.0,
                    left: 1.8,
                    damage: 30.0,
                });
                self.world.hazards.push(Hazard {
                    pos: p.pos,
                    radius: 4.0,
                    left: 1.5,
                    damage: 25.0,
                });
            } else if ranged && e.special_cd <= 0.0 && dist < 22.0 {
                e.special_cd = 3.5;
                self.world.hazards.push(Hazard {
                    pos: p.pos,
                    radius: 2.5,
                    left: 1.2,
                    damage: 8.0 + elapsed * 0.015,
                });
            }
            if dist < 2.0 && e.attack_cd <= 0.0 {
                e.attack_cd = 1.3;
                p.hurt((if e.boss { 22.0 } else { 4.0 }) * (1.0 + elapsed / 400.0));
            }
        }
        // Bounded neighbour separation via a spatial grid; avoids an O(horde²) scan.
        let mut grid = std::collections::HashMap::<(i32, i32), Vec<Point>>::new();
        for e in &self.world.enemies {
            grid.entry((
                (e.pos.x / 2.0).floor() as i32,
                (e.pos.y / 2.0).floor() as i32,
            ))
            .or_default()
            .push(e.pos);
        }
        for e in &mut self.world.enemies {
            let cell = (
                (e.pos.x / 2.0).floor() as i32,
                (e.pos.y / 2.0).floor() as i32,
            );
            let mut push = Point::default();
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(neighbors) = grid.get(&(cell.0 + dx, cell.1 + dy)) {
                        for n in neighbors {
                            let d = e.pos.distance(*n);
                            if d > 0.01 && d < 1.3 {
                                push.x += (e.pos.x - n.x) / d;
                                push.y += (e.pos.y - n.y) / d;
                            }
                        }
                    }
                }
            }
            e.pos.x = (e.pos.x + push.x.clamp(-2.0, 2.0) * STEP).clamp(-LIMIT, LIMIT);
            e.pos.y = (e.pos.y + push.y.clamp(-2.0, 2.0) * STEP).clamp(-LIMIT, LIMIT);
        }
    }
    fn loot(&mut self) {
        let dead: Vec<_> = self
            .world
            .enemies
            .iter()
            .filter(|e| e.hp <= 0.0)
            .cloned()
            .collect();
        for e in dead {
            self.world.kills += 1;
            if e.boss {
                self.world.bosses_killed += 1;
            }
            let xp = if e.boss {
                80.0
            } else if e.elite {
                12.0
            } else {
                3.0
            };
            if self.world.gems.len() < 180 {
                let id = self.id();
                self.world.gems.push(Gem {
                    id,
                    pos: e.pos,
                    xp,
                    collected: 0,
                });
            } else {
                // Merge only into a fresh gem, preserving each player's entitlement.
                if let Some(g) = self.world.gems.iter_mut().find(|g| g.collected == 0) {
                    g.xp += xp;
                } else {
                    // A saturated field of partially collected gems must not discard rewards.
                    for p in &mut self.world.players {
                        if p.alive() {
                            p.xp += xp * content::XP_RATE;
                        }
                    }
                }
            }
        }
        self.world.enemies.retain(|e| e.hp > 0.0);
        for (i, p) in self.world.players.iter_mut().enumerate() {
            if !p.alive() {
                continue;
            }
            for gem in &mut self.world.gems {
                if gem.collected & (1 << i) == 0
                    && p.pos.distance(gem.pos) < 4.5 + p.upgrades[4] as f32
                {
                    gem.collected |= 1 << i;
                    p.xp += gem.xp * content::XP_RATE;
                }
            }
            while p.xp >= p.next_xp && p.level < 49 {
                p.xp -= p.next_xp;
                p.level += 1;
                p.pending += 1;
                p.next_xp = content::xp_to_next(p.level);
            }
        }
        let mask = self
            .world
            .players
            .iter()
            .enumerate()
            .filter(|(_, p)| p.connected)
            .fold(0, |m, (i, _)| m | (1 << i));
        self.world.gems.retain(|g| g.collected & mask != mask);
    }
    fn revive(&mut self) {
        let alive: Vec<_> = self
            .world
            .players
            .iter()
            .filter(|p| p.alive())
            .map(|p| p.pos)
            .collect();
        for p in &mut self.world.players {
            if p.hp > 0.0 || !p.connected {
                continue;
            }
            if alive.iter().any(|a| a.distance(p.pos) < 3.5) {
                p.revive += STEP;
            } else {
                p.revive = 0.0;
            }
            if p.revive >= 4.0 {
                p.hp = p.max_hp * 0.4;
                p.guard = 3.0;
                p.revive = 0.0;
            }
        }
    }
}

/// The presentation uses upstream class identity rather than duplicating it in JavaScript.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn catalog() -> String {
    let classes: Vec<_> = content::CLASSES.iter().filter(|c| [1, 7, 8].contains(&c.id))
        .map(|c| serde_json::json!({"id": c.id, "name": c.name, "color": format!("#{:06x}", c.color), "display": c.looks[0]})).collect();
    serde_json::to_string(&classes).unwrap()
}

#[cfg(test)]
mod tests;

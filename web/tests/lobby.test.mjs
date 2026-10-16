// lobby.test.mjs — the lobby's pure half: what the status line says and what a code's
// instruction is. The DOM half is exercised by two tabs and a pasted code.
import assert from 'node:assert/strict';
import test from 'node:test';

import { mount, publishHint, statusText } from '../lobby.js';

test('the status line says something a player can act on in every session state', () => {
  assert.match(statusText(null), /not in a session/);
  assert.match(statusText('gathering'), /join code/);
  assert.match(statusText('waiting', 0), /waiting/);
  assert.match(statusText('waiting', 1), /connected/);
  assert.match(statusText('connected'), /connected/);
  // The one that matters: a pair that cannot connect must be told it is a network problem,
  // not left staring at "connecting…" forever.
  assert.match(statusText('failed'), /relay/);
  assert.match(statusText('closed'), /closed/);
  assert.match(statusText('something-new'), /not in a session/);
});

test('a published code tells the right player what to do with it', () => {
  assert.match(publishHint('offer'), /Send this code to the other player/);
  assert.match(publishHint('answer'), /Send this reply back to the host/);
});

test('the lobby mounts to nothing without a DOM, and never throws', () => {
  // This is the real posture check: `lobby.js` is imported on a page where it may have no
  // document and no session, and that must be a null return, not an exception.
  assert.equal(typeof document, 'undefined');
  assert.equal(mount(), null);
  assert.equal(mount({ peers: [] }), null);
});

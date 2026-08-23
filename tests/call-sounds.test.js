import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSMISSION_SOUND_PATTERNS } from '../src/media/callSounds.js';

test('local and remote transmission events have distinct start/stop cues', () => {
  const signatures = Object.values(TRANSMISSION_SOUND_PATTERNS).map((pattern) => pattern.map((note) => note.frequency).join(':'));
  assert.equal(Object.keys(TRANSMISSION_SOUND_PATTERNS).length, 4);
  assert.equal(new Set(signatures).size, 4);
  assert.ok(Object.values(TRANSMISSION_SOUND_PATTERNS).every((pattern) => pattern.length >= 2));
});

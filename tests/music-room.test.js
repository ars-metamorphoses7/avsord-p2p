import test from 'node:test';
import assert from 'node:assert/strict';
import { musicCommand, youtubeId } from '../music-room.mjs';
import { eventBind } from '../src/media/muteBind.js';

test('accepts YouTube links and rejects unrelated hosts and malformed IDs', () => {
  for (const url of ['https://youtu.be/dQw4w9WgXcQ?t=3', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ']) assert.equal(youtubeId(url), 'dQw4w9WgXcQ');
  for (const url of ['https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'file://youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=bad', 'not a url']) assert.equal(youtubeId(url), null);
});
test('pause/resume maintains position; duplicate ended messages do not skip two tracks', () => {
  let state = musicCommand(null, { action: 'add', url: 'https://youtu.be/dQw4w9WgXcQ' }, 1000);
  const first = state.queue[0].key;
  state = musicCommand(state, { action: 'add', url: 'https://youtu.be/jNQXAC9IVRw' }, 2000);
  state = musicCommand(state, { action: 'pause' }, 6000);
  assert.equal(state.position, 5);
  state = musicCommand(state, { action: 'play' }, 10000);
  assert.equal(state.position, 5);
  state = musicCommand(state, { action: 'ended', key: first }, 11000);
  assert.equal(state.queue[0].id, 'jNQXAC9IVRw');
  assert.equal(musicCommand(state, { action: 'ended', key: first }, 12000), state);
  state = musicCommand(state, { action: 'stop' }, 13000);
  assert.equal(state.queue.length, 0);
  assert.equal(state.playing, false);
});
test('queue is bounded and bad input leaves state unchanged', () => {
  let state;
  for (let i = 0; i < 30; i++) state = musicCommand(state, { action: 'add', url: 'https://youtu.be/dQw4w9WgXcQ' }, i);
  assert.throws(() => musicCommand(state, { action: 'add', url: 'https://youtu.be/dQw4w9WgXcQ' }));
  assert.throws(() => musicCommand(state, { action: 'add', url: 'bad' }));
  assert.equal(state.queue.length, 30);
});
test('binds use physical keys, modifiers and function keys', () => {
  assert.equal(eventBind({ code: 'KeyM', ctrlKey: true, shiftKey: true }), 'Control+Shift+M');
  assert.equal(eventBind({ code: 'F8' }), 'F8');
  assert.equal(eventBind({ code: 'KeyM' }), '');
  assert.equal(eventBind({ code: 'ShiftLeft', shiftKey: true }), '');
});

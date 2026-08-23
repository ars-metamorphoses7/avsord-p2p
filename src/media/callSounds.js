export const TRANSMISSION_SOUND_PATTERNS = {
  'local-start': [
    { frequency: 440, at: 0, duration: 0.11, gain: 0.035 },
    { frequency: 660, at: 0.09, duration: 0.12, gain: 0.04 },
    { frequency: 880, at: 0.18, duration: 0.16, gain: 0.045 },
  ],
  'local-stop': [
    { frequency: 740, at: 0, duration: 0.12, gain: 0.035 },
    { frequency: 520, at: 0.1, duration: 0.16, gain: 0.038 },
    { frequency: 330, at: 0.22, duration: 0.18, gain: 0.032 },
  ],
  'remote-start': [
    { frequency: 523.25, at: 0, duration: 0.12, gain: 0.027 },
    { frequency: 783.99, at: 0.12, duration: 0.2, gain: 0.032 },
  ],
  'remote-stop': [
    { frequency: 659.25, at: 0, duration: 0.12, gain: 0.026 },
    { frequency: 392, at: 0.13, duration: 0.2, gain: 0.03 },
  ],
};

export function playTransmissionSound(contextRef, type) {
  const pattern = TRANSMISSION_SOUND_PATTERNS[type];
  if (!pattern?.length) return false;
  try {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return false;
    const context = contextRef.current || new AudioContextConstructor();
    contextRef.current = context;
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const startAt = context.currentTime + 0.01;
    pattern.forEach((note) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type.startsWith('local') ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, startAt + note.at);
      gain.gain.setValueAtTime(0.0001, startAt + note.at);
      gain.gain.exponentialRampToValueAtTime(note.gain, startAt + note.at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.at + note.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt + note.at);
      oscillator.stop(startAt + note.at + note.duration + 0.01);
    });
    return true;
  } catch {
    return false;
  }
}

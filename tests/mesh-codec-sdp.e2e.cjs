const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false });
  try {
    await window.loadURL('about:blank');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const runtimeCodecs = RTCRtpSender.getCapabilities('video')?.codecs || [];
      const orderCodecs = (preferred) => {
        const rank = new Map(preferred.map((mimeType, index) => [mimeType.toLowerCase(), index]));
        return [...runtimeCodecs].sort((left, right) => (
          (rank.get(left.mimeType?.toLowerCase()) ?? 99)
          - (rank.get(right.mimeType?.toLowerCase()) ?? 99)
        ));
      };
      const parsePrimary = (sdp) => {
        const lines = String(sdp || '').split('\\r\\n');
        const payloads = lines.find((line) => line.startsWith('m=video '))?.split(' ').slice(3) || [];
        const mimeByPayload = new Map(lines
          .filter((line) => line.startsWith('a=rtpmap:'))
          .map((line) => {
            const [, payload, mime] = line.match(/^a=rtpmap:(\\d+) ([^/]+)/) || [];
            return [payload, mime ? 'video/' + mime : null];
          })
          .filter(([, mime]) => mime && !['video/rtx', 'video/red', 'video/ulpfec'].includes(mime)));
        return payloads.map((payload) => mimeByPayload.get(payload)).filter(Boolean);
      };
      const negotiate = async (offerPreferred, answerPreferred) => {
        const offerer = new RTCPeerConnection();
        const answerer = new RTCPeerConnection();
        const offerTransceiver = offerer.addTransceiver('video', { direction: 'sendrecv' });
        offerTransceiver.setCodecPreferences(orderCodecs(offerPreferred));
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription);
        const answerTransceiver = answerer.getTransceivers().find((transceiver) => transceiver.receiver.track?.kind === 'video');
        answerTransceiver.setCodecPreferences(orderCodecs(answerPreferred));
        await answerer.setLocalDescription(await answerer.createAnswer());
        const output = {
          offerPrimary: parsePrimary(offerer.localDescription.sdp),
          answerPrimary: parsePrimary(answerer.localDescription.sdp),
        };
        offerer.close();
        answerer.close();
        return output;
      };
      return {
        runtimeCodecs: runtimeCodecs.map((codec) => codec.mimeType),
        hardwareOfferSoftwareAnswer: await negotiate(
          ['video/H264', 'video/VP9', 'video/VP8'],
          ['video/VP8', 'video/H264', 'video/VP9'],
        ),
        softwareOfferHardwareAnswer: await negotiate(
          ['video/VP8', 'video/H264', 'video/VP9'],
          ['video/H264', 'video/VP9', 'video/VP8'],
        ),
      };
    })()`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    assert.equal(result.hardwareOfferSoftwareAnswer.offerPrimary[0], 'video/H264');
    assert.equal(result.hardwareOfferSoftwareAnswer.answerPrimary[0], 'video/VP8');
    assert.equal(result.softwareOfferHardwareAnswer.offerPrimary[0], 'video/VP8');
    assert.equal(result.softwareOfferHardwareAnswer.answerPrimary[0], 'video/H264');
  } finally {
    window.destroy();
  }
}

run().then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});

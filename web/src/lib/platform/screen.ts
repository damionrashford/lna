// Screen capture → a still image the vision model can read ("look at my screen"). getDisplayMedia needs a
// user gesture, so this is called from a composer button, not an agent tool. Grabs one frame, stops the
// stream immediately (no ongoing recording), and returns a PNG data URL to attach as a vision input.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function captureScreen(): Promise<string> {
  const md: any = navigator.mediaDevices;
  if (!md?.getDisplayMedia) throw new Error("Screen capture isn't supported in this browser.");
  const stream: MediaStream = await md.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    // one frame is enough; a short settle avoids a black first frame on some platforms
    await new Promise((r) => setTimeout(r, 200));
    const w = video.videoWidth || (track.getSettings() as any).width || 1280;
    const h = video.videoHeight || (track.getSettings() as any).height || 720;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    stream.getTracks().forEach((t) => t.stop()); // never keep capturing
  }
}

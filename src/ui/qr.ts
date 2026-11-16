import jsQR from 'jsqr';
import QRCode from 'qrcode';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

let detectorPromise: Promise<BarcodeDetectorLike | null> | undefined;

/** Native BarcodeDetector when available (faster, finds several codes per image); otherwise null → jsQR. */
function getDetector(): Promise<BarcodeDetectorLike | null> {
  detectorPromise ??= (async () => {
    const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Ctor) return null;
    try {
      const formats = await Ctor.getSupportedFormats?.();
      if (formats && !formats.includes('qr_code')) return null;
      return new Ctor({ formats: ['qr_code'] });
    } catch {
      return null;
    }
  })();
  return detectorPromise;
}

function jsqrScan(source: CanvasImageSource, width: number, height: number, maxDim: number, invert: boolean): string | null {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return jsQR(img.data, w, h, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' })?.data ?? null;
}

/** Decode every QR code found in an image file (screenshots of the GA transfer screen, etc.). */
export async function decodeQrImage(file: Blob): Promise<string[]> {
  const bitmap = await createImageBitmap(file);
  try {
    const detector = await getDetector();
    if (detector) {
      try {
        const found = await detector.detect(bitmap);
        if (found.length) return [...new Set(found.map((f) => f.rawValue))];
      } catch {
        /* fall back to jsQR */
      }
    }
    // jsQR sometimes misses codes in very large images; retry at smaller sizes.
    for (const maxDim of [Infinity, 1600, 900]) {
      const text = jsqrScan(bitmap, bitmap.width, bitmap.height, maxDim, true);
      if (text) return [text];
    }
    return [];
  } finally {
    bitmap.close();
  }
}

/** Continuously scans a webcam stream and reports each decoded QR text. */
export class WebcamScanner {
  private stream?: MediaStream;
  private raf = 0;
  private lastScan = 0;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onResult: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    // Closed while the permission prompt was up: release the camera immediately.
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    if (this.stopped) return;
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick);
      if (this.busy || t - this.lastScan < 150) return;
      this.lastScan = t;
      this.busy = true;
      this.scanFrame()
        .then((texts) => texts.forEach((text) => this.onResult(text)))
        .finally(() => (this.busy = false));
    };
    this.raf = requestAnimationFrame(tick);
  }

  private async scanFrame(): Promise<string[]> {
    const v = this.video;
    if (!this.stream || v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !v.videoWidth) return [];
    const detector = await getDetector();
    if (detector) {
      try {
        return (await detector.detect(v)).map((f) => f.rawValue);
      } catch {
        /* fall back to jsQR */
      }
    }
    const text = jsqrScan(v, v.videoWidth, v.videoHeight, 1280, false);
    return text ? [text] : [];
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stopped = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    // The <video> is shared between scans; only detach our own stream.
    if (this.video.srcObject === this.stream) this.video.srcObject = null;
    this.stream = undefined;
  }
}

export function qrDataUrl(text: string, width = 512): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width });
}

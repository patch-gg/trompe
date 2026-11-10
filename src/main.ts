import './ui/style.css';
import { configureFal } from './providers/fal';
import { makeApi } from './api';
import { Session } from './session';
import { mountUi } from './ui/app';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const panel = document.getElementById('panel')!;
const headless = new URLSearchParams(location.search).has('headless');
const session = new Session(canvas);
configureFal();

if (headless) {
  panel.remove();
  canvas.style.inset = '0';
  canvas.style.width = '100%';
} else {
  mountUi(session, panel);
}

function fit() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  session.viewer?.resize(w, h);
}
window.addEventListener('resize', fit);

let lastViewer: unknown = null;
let lastTime = performance.now();
function frame(now: number) {
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  if (session.viewer && session.viewer !== lastViewer) { lastViewer = session.viewer; fit(); }
  session.viewer?.tick(dt);
  if (!headless && session.viewer?.dirty) session.viewer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(window as unknown as { trompe: ReturnType<typeof makeApi> }).trompe = makeApi(session);

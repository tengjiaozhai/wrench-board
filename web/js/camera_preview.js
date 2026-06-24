// 浮动可拖动相机 preview frame。
//
// Rendered 作为 position：固定画中画风格的窗口安装到 <body> 上
// 第一个操作en。 Streams 一个 getUserMedia 轨道，以便技术人员可以保持
// 关注 agent 会看到什么en 它称之为 cam_capture。 Pos版本
// + open 状态持续在localStorage。 frame可以拖动from
// 它的标题位于视口中的任意re。
//
// 与 captureFrame() 共享 — when pre视图是 open，captureFrame
// 绘制 from this stream 而不是操作en第二个getUserMedia
// 会话（避免某些设备上的“设备繁忙”/re提示模式
// 硬件re）。

const POS_KEY = 'wrench_board.cameraPreview.position';
const OPEN_KEY = 'wrench_board.cameraPreview.open';

let _root = null;
let _video = null;
let _stream = null;
let _currentDeviceId = '';
let _dragState = null;

function _ensureRoot() {
  if (_root) return _root;
  _root = document.createElement('div');
  _root.className = 'camera-preview';
  _root.id = 'cameraPreview';
  _root.hidden = true;
  _root.innerHTML = `
    <header class="camera-preview-head" id="cameraPreviewHead">
      <span class="camera-preview-title"><span data-i18n="camera.preview.title_prefix">Camera</span> · <span id="cameraPreviewLabel">...</span></span>
      <button class="camera-preview-close" type="button"
              data-i18n-attr="aria-label:camera.preview.close_aria"
              aria-label="Close preview">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6L6 18"/>
        </svg>
      </button>
    </header>
    <video class="camera-preview-video" id="cameraPreviewVideo"
           autoplay muted playsinline></video>
  `;
  document.body.appendChild(_root);
  if (window.i18n && window.i18n.applyDom) window.i18n.applyDom(_root);

  _video = _root.querySelector('#cameraPreviewVideo');
  _root.querySelector('.camera-preview-close')
    .addEventListener('click', closePreview);

  // 拖动 — mousedown 在标题上，鼠标移动到文档ent，鼠标向上ends。
  const head = _root.querySelector('#cameraPreviewHead');
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const rect = _root.getBoundingClientRect();
    _dragState = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!_dragState) return;
    let left = e.clientX - _dragState.offsetX;
    let top = e.clientY - _dragState.offsetY;
    // 夹住视口，这样frame就不能被拖离screen。
    const w = _root.offsetWidth;
    const h = _root.offsetHeight;
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h, top));
    _root.style.left = `${left}px`;
    _root.style.top = `${top}px`;
    _root.style.right = 'auto';
    _root.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => {
    if (!_dragState) return;
    _dragState = null;
    document.body.style.userSelect = '';
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        left: _root.style.left, top: _root.style.top,
      }));
    } catch (_) { /* 忽略re 分享 */ }
  });

  // 恢复re最后一个osition（如果有）。
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const pos = JSON.parse(raw);
      if (pos.left) _root.style.left = pos.left;
      if (pos.top) _root.style.top = pos.top;
      _root.style.right = 'auto';
      _root.style.bottom = 'auto';
    }
  } catch (_) { /* 忽略re解析 */ }

  return _root;
}

export async function openPreview(deviceId, label) {
  if (!deviceId) return false;
  _ensureRoot();
  if (_currentDeviceId !== deviceId || !_stream) {
    _stopStream();
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
      });
    } catch (err) {
      console.error('[camera_preview] getUserMedia failed', err);
      return false;
    }
    _video.srcObject = _stream;
    _currentDeviceId = deviceId;
  }
  _root.hidden = false;
  const labelEl = _root.querySelector('#cameraPreviewLabel');
  if (labelEl) labelEl.textContent = label || t('camera.preview.label_fallback');
  try { localStorage.setItem(OPEN_KEY, '1'); } catch (_) { /* 忽略re */ }
  return true;
}

export function closePreview() {
  _stopStream();
  if (_root) _root.hidden = true;
  try { localStorage.setItem(OPEN_KEY, '0'); } catch (_) { /* 忽略re */ }
}

function _stopStream() {
  if (_stream) {
    _stream.getTracks().forEach((t) => t.stop());
    _stream = null;
  }
  if (_video) _video.srcObject = null;
  _currentDeviceId = '';
}

export function isPreviewOpen() {
  return Boolean(_root && !_root.hidden && _stream);
}

export function wasPreviewOpenLastSession() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch (_) {
    return false;
  }
}

// 如果选择器changed并且pre视图是open，re-附加到新的
// 设备。如果有不同的ent设备，则交换streams；如果是同一设备，no-op。
export async function updatePreviewDevice(deviceId, label) {
  if (!isPreviewOpen()) return;
  if (!deviceId) {
    closePreview();
    return;
  }
  if (deviceId === _currentDeviceId) {
    const labelEl = _root.querySelector('#cameraPreviewLabel');
    if (labelEl) labelEl.textContent = label || t('camera.preview.label_fallback');
    return;
  }
  await openPreview(deviceId, label);  // openPre视图在内部交换
}

// 在实时 preview stream 上捕捉单个 frame fr — 避免操作en
// 第二个 getUserMedia 会话 when cam_capture fires while pre视图已打开。
// 如果 preview 不是 open，则返回null。
export async function captureFromPreview(mime = 'image/jpeg', quality = 0.92) {
  if (!isPreviewOpen() || !_video || !_video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = _video.videoWidth;
  canvas.height = _video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(_video, 0, 0);
  return await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

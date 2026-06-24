// LLM 面板头的相机选择器 + capture 助手。
//
// 使用自定义 chip+popover 下拉菜单 (cohérent avec .llm-tier-chip)
// 外观与面板的 rest 相匹配 - 原生 <select> renders
// 操作系统默认的 which 在黑暗主题上是不和谐的。
//
// 公共表面：
//   - initCameraPicker(onChange) — wires chip + popover，填充
//     from enumerateDevices(), restores pre前一个选择 from
//     localStorage。 `onChange(deviceId, label)` fire 每time
//     技术人员选择了不同的ent设备（或“— aucune —”）。
//   - selectedCameraDeviceId / selectedCameraLabel — re广告选择器状态
//   - isCameraAvailable — 控制功能 frame
//   - captureFrame({deviceId, mime,quality}) → Blob — Flow B 快照。如果
//     camera_preview 是 open 并在同一设备上绘制 from
//     live <video> instead of opening a second getUserMedia.
//   - blobToBase64(Blob) → 字符串

import { captureFromPreview, isPreviewOpen } from './camera_preview.js';

const LS_KEY = 'wrench_board.cameraDeviceId';

let _cachedDevices = [];
let _selectedDeviceId = '';
let _onChangeCb = null;

function _devicesById(id) {
  return _cachedDevices.find((d) => d.deviceId === id) || null;
}

function _labelFor(id) {
  if (!id) return t('camera.picker.none');
  const d = _devicesById(id);
  return d
    ? (d.label || t('camera.picker.device_fallback', { id: id.slice(0, 6) }))
    : t('camera.picker.none');
}

function _renderChipLabel() {
  const labelEl = document.getElementById('cameraChipLabel');
  if (labelEl) labelEl.textContent = _labelFor(_selectedDeviceId);
}

function _renderPopover() {
  const popover = document.getElementById('cameraPopover');
  if (!popover) return;
  popover.innerHTML = '';
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.setAttribute('role', 'menuitem');
  noneBtn.dataset.deviceId = '';
  noneBtn.textContent = t('camera.picker.none');
  if (!_selectedDeviceId) noneBtn.classList.add('on');
  popover.appendChild(noneBtn);
  _cachedDevices.forEach((d) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.deviceId = d.deviceId;
    btn.textContent = d.label || t('camera.picker.device_fallback', { id: d.deviceId.slice(0, 6) });
    if (d.deviceId === _selectedDeviceId) btn.classList.add('on');
    popover.appendChild(btn);
  });
}

function _setSelected(id) {
  _selectedDeviceId = id || '';
  try { localStorage.setItem(LS_KEY, _selectedDeviceId); } catch (_) { /* 配额 */ }
  _renderChipLabel();
  _renderPopover();
  if (_onChangeCb) _onChangeCb(_selectedDeviceId, selectedCameraLabel());
}

export async function initCameraPicker(onChange) {
  _onChangeCb = onChange || null;
  const chip = document.getElementById('cameraChip');
  const popover = document.getElementById('cameraPopover');
  if (!chip || !popover) return;

  // 触发永久提示以解锁设备标签。未经许可
  // 许可，enumerateDevicesre转空标签。
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch (_) {
    // 权限已enied或没有相机 - 标签将为空，但
    // 选择器仍然有效（空白选项），并且用户可以稍后 re 授予。
  }

  await refreshDevices();
  if (navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }
  if (window.i18n && window.i18n.onChange) {
    window.i18n.onChange(() => { _renderChipLabel(); _renderPopover(); });
  }

  // 如果仍然是 present，则恢复re pre之前的选择。
  let saved = '';
  try { saved = localStorage.getItem(LS_KEY) || ''; } catch (_) { /* 忽略re */ }
  if (saved && _cachedDevices.some((d) => d.deviceId === saved)) {
    _selectedDeviceId = saved;
  }
  _renderChipLabel();
  _renderPopover();

  // Chip 切换popover。
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !popover.hidden;
    if (open) {
      popover.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
    } else {
      popover.hidden = false;
      chip.setAttribute('aria-expanded', 'true');
    }
  });
  // 弹出窗口将 click 委托给 menuitem 按钮。
  popover.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-device-id]');
    if (!btn) return;
    _setSelected(btn.dataset.deviceId);
    popover.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  });
  // 外侧-click + Escape close。
  document.addEventListener('click', (e) => {
    if (popover.hidden) return;
    if (popover.contains(e.target) || chip.contains(e.target)) return;
    popover.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) {
      popover.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
    }
  });
}

async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  _cachedDevices = all.filter((d) => d.kind === 'videoinput');
  // 如果 pre先前选择的设备刚刚消失red，则降级。
  if (_selectedDeviceId && !_cachedDevices.some((d) => d.deviceId === _selectedDeviceId)) {
    _setSelected('');
    return;
  }
  _renderChipLabel();
  _renderPopover();
}

export function selectedCameraDeviceId() {
  return _selectedDeviceId;
}

export function selectedCameraLabel() {
  return _selectedDeviceId ? _labelFor(_selectedDeviceId) : '';
}

export function isCameraAvailable() {
  return Boolean(_selectedDeviceId);
}

export async function captureFrame({ deviceId, mime = 'image/jpeg', quality = 0.92 }) {
  // 如果实时 pre 视图是同一设备上的 open，则捕捉 fr 其
  // 现有 stream 而不是支付另一个getUserMedia。
  if (isPreviewOpen()) {
    const blob = await captureFromPreview(mime, quality);
    if (blob) return blob;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => requestAnimationFrame(r));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

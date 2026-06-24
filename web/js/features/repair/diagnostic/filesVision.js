//  诊断聊天 - Files+Vision（Flow A宏上传+Flow B相机捕捉）
//  （从llm.js提取Phase D.6）。拥有聊天的图像侧通道：
//  向后端宣布相机功能，乐观的图像气泡+
//  日志中的全屏模式、拖/放/上传处理程序 (Flow A) 以及
//  代理触发的捕获处理程序 (Flow B)。
//
//  传输经过 services/diagnosticSocket.js (sendDiagnostic /
//  getDiagnosticWS) — 相同的实时套接字 llm.js 驱动 — 因此该模块永远不会
//  拥有自己的“ws”。相机管道来自camera.js；记录行来自
//  chatLog.js。 `t` 在调用时通过全局 window.t 解析。

import {
  blobToBase64,
  captureFrame,
  isCameraAvailable,
  selectedCameraDeviceId,
  selectedCameraLabel,
} from '../../../camera.js';
import { escapeHtml as escapeHTML } from '../../../shared/dom.js';
import { sendDiagnostic, getDiagnosticWS } from '../../../services/diagnosticSocket.js';
import { logSys } from './chatLog.js';

const t = (key, params) => (window.t ? window.t(key, params) : key);
const el = (id) => document.getElementById(id);

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;  //  5MB 原始大小，镜像后端上限

function socketOpen() {
  const ws = getDiagnosticWS();
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

//  宣布相机可用性，以便后端门cam_capture在清单中
//  (runtime_direct)并且可以短路空捕获(managed运行时)。
export function sendCapabilities() {
  if (!socketOpen()) return;
  sendDiagnostic({
    type: "client.capabilities",
    camera_available: isCameraAvailable(),
    selected_device_id: selectedCameraDeviceId(),
  });
}

//  聊天记录中乐观的图像气泡。 URL 可以是 blob: URL
//  （Flow A 乐观本地渲染）或 /api/macros/... URL（重播）。
function appendImageBubble(role, srcUrl, captionText) {
  const log = el("llmLog");
  if (!log) return;
  const row = document.createElement("div");
  row.className = `msg ${role} msg-image`;
  const roleLabel = role === "user" ? t('chat.roles.user') : t('chat.roles.agent');
  const img = document.createElement("img");
  img.src = srcUrl;
  img.alt = captionText || t('chat.image_bubble.alt');
  img.className = "llm-bubble-img";
  img.addEventListener("click", () => openImageModal(srcUrl, captionText));
  const cap = document.createElement("div");
  cap.className = "llm-bubble-caption";
  cap.textContent = captionText || "";
  row.innerHTML = `<span class="role">${escapeHTML(roleLabel)}</span>`;
  row.appendChild(img);
  if (captionText) row.appendChild(cap);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function openImageModal(srcUrl, captionText) {
  let modal = document.getElementById("llmImageModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "llmImageModal";
    modal.className = "llm-image-modal";
    modal.addEventListener("click", () => modal.remove());
    document.body.appendChild(modal);
  } else {
    modal.innerHTML = "";
  }
  const img = document.createElement("img");
  img.src = srcUrl;
  img.alt = captionText || "";
  modal.appendChild(img);
}

//  Flow A — 技术发起的宏上传（按钮/拖放）。验证尺寸 +
//  mime 客户端，乐观地渲染，然后通过 WS 传送 Base64。
export async function handleMacroUpload(file) {
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    logSys(t('chat.upload.too_large', { size: (file.size / 1024 / 1024).toFixed(1) }), true);
    return;
  }
  if (!["image/png", "image/jpeg"].includes(file.type)) {
    logSys(t('chat.upload.unsupported', { mime: file.type }), true);
    return;
  }
  if (!socketOpen()) {
    logSys(t('chat.upload.socket_closed'), true);
    return;
  }
  //  乐观本地渲染 — blob URL 在页面生命周期内保持有效。
  const url = URL.createObjectURL(file);
  appendImageBubble("user", url, t('chat.image_bubble.macro_caption'));
  try {
    const base64 = await blobToBase64(file);
    sendDiagnostic({
      type: "client.upload_macro",
      base64,
      mime: file.type,
      filename: file.name || "macro.jpg",
    });
  } catch (err) {
    logSys(t('chat.upload.failed', { error: err.message || err }), true);
  }
}

//  Flow B — 代理名为 cam_capture。从metabar选择的设备捕捉并
//  回发 client.capture_response （成功，或者为空，因此后端的
//  is_error 响应关闭代理端的循环）。
export async function handleCaptureRequest(payload) {
  const { request_id, reason } = payload;
  const deviceId = selectedCameraDeviceId();
  if (!deviceId) {
    logSys(t('chat.capture.no_camera'), true);
    sendDiagnostic({
      type: "client.capture_response",
      request_id, base64: "", mime: "", device_label: "",
    });
    return;
  }
  logSys(t('chat.capture.requested', { reason: reason || t('chat.capture.no_reason') }));
  try {
    const blob = await captureFrame({
      deviceId, mime: "image/jpeg", quality: 0.92,
    });
    if (!blob) throw new Error("canvas.toBlob returned null");
    const base64 = await blobToBase64(blob);
    //  乐观渲染，以便技术人员可以看到代理收到的内容。
    const url = URL.createObjectURL(blob);
    appendImageBubble("user", url, t('chat.image_bubble.capture_caption', { label: selectedCameraLabel() }));
    sendDiagnostic({
      type: "client.capture_response",
      request_id,
      base64,
      mime: "image/jpeg",
      device_label: selectedCameraLabel(),
    });
  } catch (err) {
    console.error("captureFrame failed", err);
    logSys(t('chat.capture.failed', { error: err.message || err }), true);
    sendDiagnostic({
      type: "client.capture_response",
      request_id, base64: "", mime: "", device_label: "",
    });
  }
}

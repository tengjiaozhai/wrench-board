//  网页/js/features/repair/workspace.js
//  修复workspace外壳。给定一个已解析的修复路径 { id, vue }，它会挂载
//  正见+副作用。 DOM 部分是现有的部分（
//  diagnostic vue、PCB 存根、schematic 的 homeSection 仪表板
//  部分，图形的画布/内存库）；这个 shell 只对
//  per-vue 加载器——它不拥有新的 DOM 和新的样式。活跃的
//  设备/维修上下文已在存储中（awaitsyncContextFromUrl运行
//  main.js上游）。
//
//  使用相同的 ?v=fitzoom 查询 main.js 使用 — ESM 导入 schematic 模块
//  通过 URL 来键模块，因此不同的（或缺失的）查询将创建第二个
//  具有自己的 STATE 的模块实例。
import { currentSession, currentViewMode, applyMemoireMode } from "../../router.js";
import { renderRepairDashboard } from "./diagnostic/dashboard.js";
import { loadSchematic } from "../../schematic.js?v=fitzoom";
import { loadMemoryBank } from "../../memory_bank.js";
import { openLLMPanelIfRepairParam } from "../../llm.js";
import { firstDiagTourPending } from "./diagnostic/coaching.js";

/**
 * 挂载主动修复vue。 `deps.maybeLoadGraph` 由 main.js 注入
 * 避免循环导入（main.js拥有图形安装防护+窗口垫片）。
 
 */
export async function mountRepairVue(route, { maybeLoadGraph }) {
  const session = currentSession();
  switch (route.vue) {
    case "diagnostic":
      //  diagnostic vue 是修复仪表板（标题/数据网格/
      //  对话/发现/timeline/包）+聊天overlay。
      if (session) renderRepairDashboard(session);
      //  当首轮游览正在播放/欠下时，保持聊天自动打开，
      //  所以它的早期泡沫没有被掩盖；巡演的最后一步邀请
      //  技术自己打开聊天。
      if (!firstDiagTourPending()) openLLMPanelIfRepairParam();
      break;
    case "pcb":
      //  Boardview init 由 router.navigate() 的 pcb 分支处理
      //  (window.initBoardview)，在 DOM 可见性切换时触发。
      break;
    case "schematic":
      loadSchematic();
      break;
    case "graph": {
      const mode = currentViewMode();
      applyMemoireMode(mode);
      await maybeLoadGraph();
      if (mode === "md") loadMemoryBank();
      break;
    }
  }
}

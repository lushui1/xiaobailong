const STORAGE_L2 = "xiaobailong-panel-l2-collapsed";

export function initPanelCollapse() {
  function setPanel(collapsed) {
    document.body.classList.toggle("l2-collapsed", collapsed);
    try { localStorage.setItem(STORAGE_L2, collapsed ? "1" : "0"); } catch {}
  }

  function togglePanel() {
    setPanel(!document.body.classList.contains("l2-collapsed"));
  }

  try {
    if (localStorage.getItem(STORAGE_L2) === "1") document.body.classList.add("l2-collapsed");
  } catch {}

  document.getElementById("panel-l2-tab")?.addEventListener("click", togglePanel);

  // 侧栏图谱按钮和控制台监控按钮也可以切换右面板
  document.getElementById("sidebar-graph")?.addEventListener("click", togglePanel);
  document.getElementById("toggle-l2-btn")?.addEventListener("click", togglePanel);

  window.addEventListener("keydown", (event) => {
    if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "]") { event.preventDefault(); togglePanel(); }
  });
}

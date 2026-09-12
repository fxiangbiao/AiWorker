/**
 * 全局注入声明（Sprint 49）：服务端在 index.html 里注入进程 token，
 * 供「权限」面板调用写接口时带 X-AiWorker-Token（响应不带 ACAO:*，跨源页面读不到）
 */
interface Window {
  __AIWORKER_TOKEN__?: string;
}

/**
 * 无确认通道作用域（Sprint 52 收尾）
 *
 * 子智能体执行上下文内，confirm/ask 一律 fail-closed（立即返回 null，不落 stdin 交互）。
 * 用 AsyncLocalStorage 做**作用域隔离**：此前的实现是把进程级 provider 换成"一律拒绝"，
 * 结果子智能体一跑就把**父会话**的通道一起顶掉——主智能体所有需确认的操作被自动拒绝（功能性自锁）。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const noChannel = new AsyncLocalStorage<true>();

/** 在该作用域内执行：confirm/ask 立即返回 null */
export function runWithoutChannel<T>(fn: () => Promise<T>): Promise<T> {
  return noChannel.run(true, fn);
}

/** 当前是否处于"无确认通道"作用域（子智能体内部） */
export function isChannelSuppressed(): boolean {
  return noChannel.getStore() === true;
}

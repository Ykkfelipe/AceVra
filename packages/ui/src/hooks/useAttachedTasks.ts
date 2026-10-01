import { useEffect, useRef, useState } from "react";
import type { TaskEvent, TaskView } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  ACTIVE_TASK_STATES,
  appendTaskEvents,
  type TaskLiveLine,
} from "@/account/executionPresentation.js";

const ACTIVE_STATE_POLL_MS = 1500;
const ACTIVE_EVENTS_POLL_MS = 700;

/**
 * Task state for the given ids, read from the real owner (`listTasks`). Polls only while one of
 * them is active; a finished set is read once. Never starts or mutates a task.
 */
export function useAttachedTasks(taskIds: readonly string[]) {
  const account = useOptionalPlatform()?.account;
  const [tasks, setTasks] = useState<Record<string, TaskView>>({});
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const key = taskIds.join(",");
  const loaded = loadedKey === key;
  // 首次读取前缺失的任务按「仍在启动」轮询；读取后仍缺失的（如已登出看不到远程任务）不再轮询。
  const anyActive = taskIds.some((id) =>
    tasks[id] ? ACTIVE_TASK_STATES.includes(tasks[id]!.state) : !loaded,
  );
  useEffect(() => {
    if (!account || !key) return;
    const wanted = new Set(key.split(","));
    let live = true;
    const read = async () => {
      const all = await account.listTasks().catch(() => null);
      if (!live || !all) return;
      setTasks(Object.fromEntries(all.filter((t) => wanted.has(t.id)).map((t) => [t.id, t])));
      setLoadedKey(key);
    };
    void read();
    if (!anyActive) return () => void (live = false);
    const timer = setInterval(() => void read(), ACTIVE_STATE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [account, key, anyActive]);
  return { tasks, loaded };
}

/**
 * Latest live lines for one task from its TaskEvents (cursor moves forward only). Polls while the
 * task is active plus one trailing read so the final output and terminal event are shown.
 */
export function useTaskEventLines(taskId: string, active: boolean) {
  const account = useOptionalPlatform()?.account;
  const [lines, setLines] = useState<TaskLiveLine[]>([]);
  const [terminal, setTerminal] = useState<TaskEvent[]>([]);
  const after = useRef(0);
  useEffect(() => {
    after.current = 0;
    setLines([]);
    setTerminal([]);
  }, [taskId]);
  useEffect(() => {
    if (!account) return;
    let live = true;
    const read = async () => {
      const events = await account.getTaskEvents(taskId, after.current).catch(() => []);
      if (!live || events.length === 0) return;
      const fresh = events.filter((e) => e.sequence > after.current);
      if (fresh.length === 0) return;
      after.current = fresh.at(-1)!.sequence;
      setLines((previous) => appendTaskEvents(previous, fresh));
      const ends = fresh.filter((e) =>
        ["process.completed", "process.failed", "task.cancelled"].includes(e.type),
      );
      if (ends.length > 0) setTerminal((previous) => [...previous, ...ends]);
    };
    void read();
    if (!active) return () => void (live = false);
    const timer = setInterval(() => void read(), ACTIVE_EVENTS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [account, taskId, active]);
  return { lines, terminalEvents: terminal };
}

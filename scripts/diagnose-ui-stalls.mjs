#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const usage = 'node scripts/diagnose-ui-stalls.mjs [--minutes 15] [--session <id>] [--base-dir <dir>] [--json]';
const options = { minutes: 15, baseDir: process.env.VERMILLION_PERSISTENCE_BASE_DIR || join(homedir(), '.vermillion') };
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { console.log(usage); process.exit(0); }
    if (arg === '--json') { options.json = true; continue; }
    if (!['--minutes', '--session', '--base-dir'].includes(arg) || !args[i + 1]) throw new Error('Invalid argument: ' + arg);
    const value = args[++i];
    if (arg === '--minutes') options.minutes = Number(value);
    if (arg === '--session') options.session = value;
    if (arg === '--base-dir') options.baseDir = value;
  }
  if (!Number.isFinite(options.minutes) || options.minutes <= 0) throw new Error('--minutes must be positive');
  const cutoff = Date.now() - options.minutes * 60_000;
  const directory = join(options.baseDir, 'logs');
  const names = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const kinds = new Set(['ui-input-delay', 'renderer-stall', 'renderer-long-task']);
  const incidents = [];
  const heartbeats = [];
  let invalidLines = 0;
  let incidentCount = 0;
  for (const name of names.filter(name => /^perf-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(name))) {
    const path = join(directory, name);
    if ((await stat(path)).mtimeMs < cutoff) continue;
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { invalidLines++; continue; }
      if (!Number.isFinite(Date.parse(entry.occurredAt)) || Date.parse(entry.occurredAt) < cutoff) continue;
      if (options.session && entry.sessionId !== options.session) continue;
      if (entry.kind === 'renderer-heartbeat') {
        heartbeats.push(entry);
        if (heartbeats.length > 200) heartbeats.shift();
      }
      if (!kinds.has(entry.kind)) continue;
      incidentCount++;
      incidents.push(entry);
      incidents.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
      if (incidents.length > 100) incidents.shift();
    }
  }
  const report = { directory, minutes: options.minutes, sessionId: options.session,
    incidentCount, shown: incidents.length, invalidLines, incidents, heartbeats };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`最近 ${options.minutes} 分钟：${incidentCount} 条卡顿告警（显示最近 ${incidents.length} 条）\n日志：${directory}`);
    if (!incidentCount) console.log('没有匹配的告警；这不代表没有卡顿，需确认桌面已运行最新监测代码。');
    for (const entry of incidents) {
      const metrics = entry.metrics || {};
      const duration = metrics.delayMs ?? metrics.durationMs ?? metrics.lagMs;
      console.log(`\n${entry.occurredAt} ${entry.kind} ${duration ?? '?'}ms session=${entry.sessionId || '-'}`);
      if (metrics.queueDelayMs !== undefined) console.log(`  输入排队 ${metrics.queueDelayMs}ms，处理到下一帧 ${metrics.frameDelayMs}ms`);
      const operations = entry.context?.recentOperations || [];
      if (!operations.length) console.log('  无关联操作记录，尚未归因。');
      for (const operation of operations) {
        console.log(`  ${operation.kind} ${operation.name} ${operation.durationMs}ms ${JSON.stringify(operation.details || {})}`);
      }
    }
    if (invalidLines) console.log(`\n跳过 ${invalidLines} 条不完整日志行。`);
    console.log('\n相邻操作仅是排查线索；async 是异步等待，render 包含调度与子树提交，不能当作独占 CPU 耗时或累加嵌套跨度。');
  }
} catch (error) {
  console.error(error.message + '\n' + usage);
  process.exitCode = 1;
}

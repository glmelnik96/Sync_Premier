#!/usr/bin/env node
/**
 * CEP remote debugging driver (2026-06-11).
 * Подключается к debug-порту панели (см. .debug, порт 8098) по Chrome
 * DevTools Protocol и выполняет JS в контексте панели. Используется для
 * ручной валидации фич прямо в живом Premiere.
 *
 * Использование:
 *   node tools/cep-debug.mjs targets            — список страниц на порту
 *   node tools/cep-debug.mjs eval "<js>"        — выполнить JS в панели (awaitPromise)
 *   node tools/cep-debug.mjs evalfile <path>    — выполнить JS из файла (без проблем с shell-экранированием)
 *   node tools/cep-debug.mjs host "<extendscript>" — выполнить ExtendScript через evalScript
 *   node tools/cep-debug.mjs hostfile <path>    — ExtendScript из файла
 *   node tools/cep-debug.mjs reload             — перезагрузить панель (подтянуть новый код)
 *
 * Примеры:
 *   node tools/cep-debug.mjs eval "document.title"
 *   node tools/cep-debug.mjs host "app.project.activeSequence.name"
 *   node tools/cep-debug.mjs host "$._EXT_PRM_.setPlayheadSec(12.5)"
 */

const PORT = process.env.CEP_DEBUG_PORT || 8098;

async function getTargets() {
  const res = await fetch(`http://localhost:${PORT}/json`);
  return res.json();
}

function cdpEval(wsUrl, expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP timeout ${timeoutMs}ms`));
    }, timeoutMs);
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WS error: ' + (e.message || e))); };
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise }
      }));
    };
    ws.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }
      if (data.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (data.error) { reject(new Error('CDP: ' + JSON.stringify(data.error))); return; }
      const r = data.result || {};
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        reject(new Error('Exception в панели: ' + (ex.exception?.description || ex.text)));
        return;
      }
      resolve(r.result?.value);
    };
  });
}

/* ExtendScript через мост панели: __adobe_cep__.evalScript — callback API,
   оборачиваем в Promise на стороне панели. */
function hostExpr(extendscript) {
  const esc = JSON.stringify(extendscript);
  return `new Promise(function (resolve) {
    window.__adobe_cep__.evalScript(${esc}, function (r) { resolve(String(r)); });
  })`;
}

async function main() {
  let [cmd, arg] = process.argv.slice(2);
  if (!cmd || !['targets', 'eval', 'evalfile', 'host', 'hostfile', 'reload'].includes(cmd)) {
    console.error('Использование: cep-debug.mjs targets | eval "<js>" | evalfile <path> | host "<es>" | hostfile <path> | reload');
    process.exit(2);
  }
  if (cmd === 'evalfile' || cmd === 'hostfile') {
    const { readFileSync } = await import('node:fs');
    arg = readFileSync(arg, 'utf8');
    cmd = cmd === 'evalfile' ? 'eval' : 'host';
  }
  const targets = await getTargets();
  if (cmd === 'targets') {
    for (const t of targets) console.log(`${t.title}\t${t.url}\t${t.webSocketDebuggerUrl}`);
    return;
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('Нет page-таргета на порту ' + PORT + ' (панель закрыта?)');

  if (cmd === 'reload') {
    await cdpEval(page.webSocketDebuggerUrl, 'location.reload(); "reloading"', { awaitPromise: false });
    console.log('reload отправлен:', page.title);
    return;
  }
  const expression = cmd === 'host' ? hostExpr(arg) : arg;
  const value = await cdpEval(page.webSocketDebuggerUrl, expression);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

main().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });

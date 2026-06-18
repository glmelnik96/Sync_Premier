/**
 * Тонкий ExtendScript-host плагина «ИИ: синхронизация».
 * Гибрид-пайплайн (FCP7 XML round-trip): экспорт активной секвенции в XML и импорт
 * синхро-XML обратно. Никакой мутации живого таймлайна — Premiere строит свежие
 * секвенции импортом (это снимает проблемы прямого move(): длительность, плейхед,
 * развал секвенции). Каждая функция возвращает JSON-строку.
 */
/**
 * JSON-полифилл для ExtendScript (нативного JSON нет в ряде версий Premiere → весь host
 * падал бы с ReferenceError: JSON is undefined). Без Unicode-regex: json2.js Крокфорда
 * содержит Unicode-диапазоны в литералах, на которых ExtendScript падает с SyntaxError
 * ещё до выполнения. Поэтому stringify — посимвольный обход с escape-маппой, parse — eval
 * с минимальной проверкой (вход всегда наш собственный, доверенный).
 */
if (typeof JSON === 'undefined') {
  JSON = {};
  (function () {
    var m = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };
    function q(s) {
      var r = '', i, c, e;
      for (i = 0; i < s.length; i++) {
        c = s.charAt(i); e = m[c];
        if (e) r += e;
        else if (c.charCodeAt(0) < 32) r += '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        else r += c;
      }
      return '"' + r + '"';
    }
    function ser(v) {
      var i, k, u, p;
      if (v === null) return 'null';
      switch (typeof v) {
        case 'string': return q(v);
        case 'number': return isFinite(v) ? String(v) : 'null';
        case 'boolean': return String(v);
        case 'object':
          p = [];
          if (v instanceof Array) {
            for (i = 0; i < v.length; i++) p[i] = ser(v[i]) || 'null';
            return '[' + p.join(',') + ']';
          }
          for (k in v) { if (v.hasOwnProperty(k)) { u = ser(v[k]); if (u) p.push(q(k) + ':' + u); } }
          return '{' + p.join(',') + '}';
        default: return undefined;
      }
    }
    JSON.stringify = function (v) { return ser(v); };
    JSON.parse = function (t) {
      if (t.charAt(0) !== '{' && t.charAt(0) !== '[') throw new SyntaxError('JSON.parse');
      return eval('(' + t + ')');
    };
  })();
}

if (typeof $._SYNC_ === 'undefined') { $._SYNC_ = {}; }

$._SYNC_.version = '0.2.1';

/** Экспорт активной секвенции в FCP7 XML во временную ASCII-папку (кириллица в пути
    ломает File()). → {ok, path, seqName}. Панель прочитает файл, синхронизирует, импортирует. */
$._SYNC_.exportActiveSequenceXml = function () {
  try {
    if (!app.project || !app.project.activeSequence) return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    var seq = app.project.activeSequence;
    if (typeof seq.exportAsFinalCutProXML !== 'function') return JSON.stringify({ ok: false, error: 'exportAsFinalCutProXML недоступен' });
    var f = new File(Folder.temp.fsName + '/sync_premier_in.xml');
    var ok = seq.exportAsFinalCutProXML(f.fsName);
    if (!ok) return JSON.stringify({ ok: false, error: 'экспорт XML не удался' });
    return JSON.stringify({ ok: true, path: f.fsName, seqName: String(seq.name) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** Импорт синхро-XML (создаёт секвенцию _SYNCED). paramsJson: {path}. */
$._SYNC_.importSyncedXml = function (paramsJson) {
  try {
    var p = JSON.parse(paramsJson);
    if (!app.project) return JSON.stringify({ ok: false, error: 'Нет проекта' });
    var f = new File(p.path);
    if (!f.exists) return JSON.stringify({ ok: false, error: 'Файл не найден: ' + p.path });
    var before = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) before[String(app.project.sequences[i].sequenceID)] = 1;
    var ok = app.project.importFiles([f.fsName], true, app.project.rootItem, false);
    var added = [];
    for (var j = 0; j < app.project.sequences.numSequences; j++) {
      var sq = app.project.sequences[j];
      if (!before[String(sq.sequenceID)]) added.push({ id: String(sq.sequenceID), name: String(sq.name) });
    }
    /* активировать главную _SYNCED */
    for (var k = 0; k < added.length; k++) if (/_SYNCED$/.test(added[k].name)) { app.project.openSequence(added[k].id); break; }
    return JSON.stringify({ ok: !!ok, imported: added });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

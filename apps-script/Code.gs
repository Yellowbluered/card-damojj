/**
 * ============================================================
 *  🎴 合夥買卡資金池 — 雲端資料庫後端 (Google Apps Script)
 * ============================================================
 *
 *  部署步驟（只需做一次）：
 *   1. 開一個新的 Google 試算表（或任何現有試算表）
 *   2. 選單「擴充功能」→「Apps Script」
 *   3. 刪除原本內容，貼上本檔全部代碼
 *   4. 右上角「部署」→「新增部署作業」→ 類型揀「網頁應用程式」
 *        • 說明：資金池 API
 *        • 執行身分：我
 *        • 具有應用程式存取權的使用者：任何人
 *   5. 按「部署」→ 授權 → 複製「網頁應用程式網址」
 *   6. 把網址貼回網站嘅「設定精靈」
 *
 *  資料會以一行一筆嘅方式存喺名為 DB 嘅工作表，你可以直接開表睇。
 *  卡牌相片會存喺 Google Drive 嘅「資金池卡牌相片」資料夾。
 * ============================================================
 */

/** 存取密鑰。設定精靈會自動幫你換成隨機字串。 */
var SECRET_KEY = 'REPLACE_WITH_KEY';

var SHEET_NAME = 'DB';
var PROP_SS_ID = 'SS_ID';
var PROP_FOLDER_ID = 'FOLDER_ID';
var PROP_REV = 'REV';
var PROP_UPDATED = 'UPDATED_AT';

/* ============================================================
   入口
   ============================================================ */
function doGet(e) {
  return route_(e, null);
}

function doPost(e) {
  var body = {};
  if (e && e.postData && e.postData.contents) {
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      body = {};
    }
  }
  return route_(e, body);
}

function route_(e, body) {
  try {
    var p = (e && e.parameter) || {};
    body = body || {};

    var key = p.k || body.key || '';
    if (SECRET_KEY && SECRET_KEY !== 'REPLACE_WITH_KEY' && key !== SECRET_KEY) {
      return json_({ ok: false, error: '密鑰錯誤（請用設定精靈產生嘅完整網址）' });
    }

    var action = body.action || p.action || 'get';

    if (action === 'ping' || action === 'get') {
      var s = readState_();
      return json_({
        ok: true,
        rev: s.rev,
        updatedAt: s.updatedAt,
        state: { deposits: s.deposits, cards: s.cards }
      });
    }

    if (action === 'merge') {
      var r = mergeAndSave_(body.state || {});
      return json_({ ok: true, rev: r.rev, updatedAt: r.updatedAt, state: r.state });
    }

    if (action === 'upload') {
      var up = uploadImage_(body.data, body.filename);
      return json_({ ok: true, url: up.url, id: up.id });
    }

    return json_({ ok: false, error: '未知指令：' + action });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   資料表
   ============================================================ */
function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var ss = null;
  var ssId = props.getProperty(PROP_SS_ID);

  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch (err) { ss = null; }
  }
  if (!ss) {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { ss = null; }
    if (!ss) ss = SpreadsheetApp.create('合夥買卡資金池資料庫');
    props.setProperty(PROP_SS_ID, ss.getId());
  }

  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, 4).setValues([['類型', 'ID', '更新時間', '資料 JSON']]);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 90);
    sh.setColumnWidth(2, 160);
    sh.setColumnWidth(3, 150);
    sh.setColumnWidth(4, 420);
  }
  return sh;
}

function readState_() {
  var sh = getSheet_();
  var out = { deposits: [], cards: [], rev: 0, updatedAt: 0 };
  var last = sh.getLastRow();
  if (last < 2) return out;

  var values = sh.getRange(2, 1, last - 1, 4).getValues();
  for (var i = 0; i < values.length; i++) {
    var kind = String(values[i][0] || '').trim();
    var raw = values[i][3];
    if (!raw) continue;
    var rec;
    try { rec = JSON.parse(raw); } catch (err) { continue; }
    if (!rec || !rec.id) continue;
    rec.id = String(rec.id);
    rec.updatedAt = Number(rec.updatedAt || values[i][2] || 0);
    if (kind === 'card' || kind === 'cards') out.cards.push(rec);
    else out.deposits.push(rec);
  }

  var props = PropertiesService.getScriptProperties();
  out.rev = Number(props.getProperty(PROP_REV) || 0);
  out.updatedAt = Number(props.getProperty(PROP_UPDATED) || 0);
  return out;
}

function writeState_(merged) {
  var sh = getSheet_();
  var rows = [];

  merged.deposits.forEach(function (r) {
    rows.push(['deposit', String(r.id), Number(r.updatedAt || 0), JSON.stringify(r)]);
  });
  merged.cards.forEach(function (r) {
    rows.push(['card', String(r.id), Number(r.updatedAt || 0), JSON.stringify(r)]);
  });

  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 4).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
    sh.getRange(2, 3, rows.length, 1).setNumberFormat('0');
  }
}

/* ============================================================
   合併（逐筆 Last-Write-Wins）
   ============================================================ */
function mergeStates_(a, b) {
  var out = { deposits: [], cards: [] };
  ['deposits', 'cards'].forEach(function (k) {
    var map = {};
    var order = [];
    var lists = [a[k] || [], b[k] || []];
    for (var li = 0; li < lists.length; li++) {
      var list = lists[li];
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (!r || !r.id) continue;
        var id = String(r.id);
        var t = Number(r.updatedAt || 0);
        if (!map[id]) {
          map[id] = r;
          order.push(id);
        } else if (t >= Number(map[id].updatedAt || 0)) {
          map[id] = r;
        }
      }
    }
    out[k] = order.map(function (id) { return map[id]; });
  });
  return out;
}

function mergeAndSave_(incoming) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var current = readState_();
    var merged = mergeStates_(current, incoming);
    writeState_(merged);

    var props = PropertiesService.getScriptProperties();
    var rev = Number(props.getProperty(PROP_REV) || 0) + 1;
    var now = Date.now();
    props.setProperties({ REV: String(rev), UPDATED_AT: String(now) });

    return {
      rev: rev,
      updatedAt: now,
      state: { deposits: merged.deposits, cards: merged.cards }
    };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   相片上載到 Google Drive
   ============================================================ */
function uploadImage_(base64, filename) {
  if (!base64) throw new Error('缺少圖片資料');

  var props = PropertiesService.getScriptProperties();
  var folder = null;
  var folderId = props.getProperty(PROP_FOLDER_ID);

  if (folderId) {
    try { folder = DriveApp.getFolderById(folderId); } catch (err) { folder = null; }
  }
  if (!folder) {
    folder = DriveApp.createFolder('資金池卡牌相片');
    props.setProperty(PROP_FOLDER_ID, folder.getId());
  }

  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, 'image/jpeg', filename || ('card_' + Date.now() + '.jpg'));
  var file = folder.createFile(blob);

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    // 機構帳戶可能封鎖連結分享，相片仍會保存，但其他裝置可能睇唔到
  }

  return {
    url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800',
    id: file.getId()
  };
}

/* ============================================================
   首次部署後可手動執行一次，確認權限已授權
   ============================================================ */
function 測試連線() {
  var s = readState_();
  Logger.log('OK — 入金 %s 筆，卡牌 %s 張，rev=%s',
    s.deposits.length, s.cards.length, s.rev);
}

'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'cat.html');

const oldBlock = `          <select id="mpFrequency" class="form-select" onchange="onMpFreqChange()">
            <option value="毎日">毎日</option>
            <option value="隔日">隔日</option>
            <option value="weekly">毎週（曜日指定）</option>
            <option value="monthly">月1回（日付指定）</option>
            <option value="必要時">必要時</option>
          </select>
          <div id="mpFreqWeekly" style="display:none;margin-top:6px;">`;

const newBlock = `          <select id="mpFrequency" class="form-select" onchange="onMpFreqChange()">
            <option value="毎日">毎日</option>
            <option value="隔日(A)">隔日 — A日</option>
            <option value="隔日(B)">隔日 — B日</option>
            <option value="3日に1回">3日に1回</option>
            <option value="週3回">週3回（月・水・金）</option>
            <option value="週1回">週1回</option>
            <option value="weekly">毎週（曜日指定）</option>
            <option value="monthly">月1回（日付指定）</option>
            <option value="月末のみ">月末のみ</option>
            <option value="必要時">必要時</option>
          </select>
          <div id="mpAlternateHint" class="form-hint" style="display:none;margin-top:4px;font-size:11px;color:#ff9800;">⚠ 交互投薬: 同じプリセット内に A日 と B日 で別の薬を登録してください</div>
          <div id="mpCycleHint" class="form-hint" style="display:none;margin-top:4px;font-size:11px;color:#2196f3;">📅 起算日 = プリセット適用日（適用日→投与、以降N日間隔）</div>
          <div id="mpFreqWeekly" style="display:none;margin-top:6px;">`;

let content = fs.readFileSync(file, 'utf8');
const eol = content.includes('\r\n') ? '\r\n' : '\n';

function normalizeEol(s) {
  return s.split(/\r?\n/).join(eol);
}

const oldNorm = normalizeEol(oldBlock);
const newNorm = normalizeEol(newBlock);

if (!content.includes(oldNorm)) {
  console.error('ERROR: expected block not found in cat.html');
  process.exit(1);
}

content = content.replace(oldNorm, newNorm);
fs.writeFileSync(file, content, 'utf8');

console.log('OK: replacement written to', file);

const idx = content.indexOf('id="mpFrequency"');
if (idx === -1) {
  console.error('ERROR: mpFrequency not found after write');
  process.exit(1);
}

const lines = content.slice(0, idx).split(/\r?\n/);
const startLine = lines.length;
const chunk = content.slice(idx);
const chunkLines = chunk.split(/\r?\n/).slice(0, 28);
console.log('\n--- lines around mpFrequency (1-based) ---');
for (let i = 0; i < chunkLines.length; i++) {
  console.log(String(startLine + i).padStart(5, ' ') + '|' + chunkLines[i]);
}

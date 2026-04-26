/**
 * cat-name-dict-insert 単体テスト（D1 はモック）
 */
import { describe, it, expect } from 'vitest';
import { insertCatNameDictWithSources, selectPendingMisrecognitionIdsByAttempted } from './cat-name-dict-insert.js';

function stmtWithSql(sql) {
  return {
    bind: function () {
      return { _sql: sql };
    },
  };
}

describe('cat-name-dict-insert', () => {
  it('resolveMisrecognition あり: batch で INSERT + sources + UPDATE の順', async () => {
    var captured = [];
    var db = {
      prepare: function (sql) {
        return stmtWithSql(sql);
      },
      batch: async function (stmts) {
        captured = stmts.map(function (s) {
          return s._sql;
        });
        return [{ results: [{ id: 42 }] }];
      },
    };

    var id = await insertCatNameDictWithSources(db, {
      catId: 'cat_1',
      variant: 'てすと',
      variantType: 'manual_promoted',
      priority: 88,
      entrySource: 'manual_promoted',
      misrecognitionLogIds: [100, 101],
      resolveMisrecognition: { catId: 'cat_1', attemptedName: 'てすと' },
    });

    expect(id).toBe(42);
    expect(captured.length).toBe(4);
    expect(captured[0]).toMatch(/INSERT INTO cat_name_dictionary/);
    expect(captured[0]).toMatch(/RETURNING id/);
    expect(captured[1]).toMatch(/INSERT OR IGNORE INTO cat_name_dictionary_sources/);
    expect(captured[1]).toMatch(/MAX\(id\) FROM cat_name_dictionary/);
    expect(captured[2]).toMatch(/INSERT OR IGNORE INTO cat_name_dictionary_sources/);
    expect(captured[3]).toMatch(/UPDATE misrecognition_log SET resolved_cat/);
  });

  it('resolveMisrecognition あり・ログ id なし: batch は INSERT + UPDATE のみ', async () => {
    var n = 0;
    var db = {
      prepare: function (sql) {
        return stmtWithSql(sql);
      },
      batch: async function (stmts) {
        n = stmts.length;
        return [{ results: [{ id: 99 }] }];
      },
    };

    var id = await insertCatNameDictWithSources(db, {
      catId: 'cat_1',
      variant: 'x',
      variantType: 'manual_promoted',
      priority: 88,
      entrySource: 'manual_promoted',
      misrecognitionLogIds: [],
      resolveMisrecognition: { catId: 'cat_1', attemptedName: 'x' },
    });

    expect(id).toBe(99);
    expect(n).toBe(2);
  });

  it('resolveMisrecognition なし: batch を使わず first / run', async () => {
    var batchCalled = false;
    var firstCalls = 0;
    var runCalls = 0;
    var db = {
      prepare: function (sql) {
        return {
          bind: function () {
            return {
              first: async function () {
                firstCalls++;
                if (sql.indexOf('INSERT INTO cat_name_dictionary') !== -1) {
                  return { id: 7 };
                }
                return null;
              },
              run: async function () {
                runCalls++;
              },
            };
          },
        };
      },
      batch: async function () {
        batchCalled = true;
        return [];
      },
    };

    var id = await insertCatNameDictWithSources(db, {
      catId: 'cat_1',
      variant: 'y',
      variantType: 'manual_ui',
      priority: 88,
      entrySource: 'manual_ui',
      misrecognitionLogIds: [],
    });

    expect(id).toBe(7);
    expect(batchCalled).toBe(false);
    expect(firstCalls).toBe(1);
    expect(runCalls).toBe(0);
  });

  it('batch の先頭結果に id が無いときは例外', async () => {
    var db = {
      prepare: function (sql) {
        return stmtWithSql(sql);
      },
      batch: async function () {
        return [{ results: [] }];
      },
    };

    await expect(
      insertCatNameDictWithSources(db, {
        catId: 'c',
        variant: 'v',
        variantType: 't',
        priority: 1,
        entrySource: 'manual_promoted',
        resolveMisrecognition: { catId: 'c', attemptedName: 'v' },
      })
    ).rejects.toThrow(/no RETURNING id/);
  });

  it('selectPendingMisrecognitionIdsByAttempted が id を返す', async () => {
    var db = {
      prepare: function (sql) {
        expect(sql).toMatch(/failure_type = 'cat_name'/);
        return {
          bind: function () {
            return {
              all: async function () {
                return { results: [{ id: 3 }, { id: 4 }] };
              },
            };
          },
        };
      },
    };

    var ids = await selectPendingMisrecognitionIdsByAttempted(db, 'foo');
    expect(ids).toEqual([3, 4]);
  });
});

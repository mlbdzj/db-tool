import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { compactSql, formatDuration, formatRelative } from '../lib/format';
import type { HistoryEntry } from '../lib/types';
import { Modal } from './Modal';

interface Props {
  connectionId: string;
  onClose: () => void;
  onPick: (entry: HistoryEntry) => void;
}

export function HistoryDialog({ connectionId, onClose, onPick }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .history(connectionId)
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  async function clear() {
    if (!window.confirm('清空该连接的全部查询历史？')) return;
    await api.clearHistory(connectionId);
    setEntries([]);
  }

  return (
    <Modal
      title="查询历史"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--danger" onClick={clear} disabled={!entries?.length}>
            清空历史
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {error && <div className="panel-message panel-message--error">{error}</div>}
      {entries === null && <div className="panel-message">加载中…</div>}
      {entries?.length === 0 && <div className="panel-message">还没有查询记录。</div>}
      {entries?.map((entry) => (
        <button
          type="button"
          key={entry.id}
          className="history-item"
          onClick={() => {
            onPick(entry);
            onClose();
          }}
        >
          <span className="history-item__sql">{compactSql(entry.sql, 140)}</span>
          <span className="history-item__meta">
            <span>{formatRelative(entry.ranAt)}</span>
            <span>{entry.database ?? '默认库'}</span>
            <span className={entry.ok ? 'badge badge--ok' : 'badge badge--danger'}>
              {entry.ok ? `${entry.rowCount} 行` : '失败'}
            </span>
            <span>{formatDuration(entry.durationMs)}</span>
          </span>
          {entry.error && <span className="history-item__meta" style={{ color: 'var(--danger)' }}>{compactSql(entry.error, 140)}</span>}
        </button>
      ))}
    </Modal>
  );
}

import { useState } from 'react';
import { api } from '../lib/api';
import type { Connection, ConnectionDraft, DbKind } from '../lib/types';
import { Modal } from './Modal';

interface Props {
  connection: Connection | null;
  onClose: () => void;
  onSaved: (connection: Connection, isNew: boolean) => void;
  onDeleted: (id: string) => void;
  onNotify: (text: string, kind?: 'ok' | 'error') => void;
}

const DEFAULT_PORTS: Record<DbKind, number> = { mysql: 3306, postgres: 5432 };

export function ConnectionDialog({ connection, onClose, onSaved, onDeleted, onNotify }: Props) {
  const isNew = connection === null;
  const [draft, setDraft] = useState<ConnectionDraft & { password: string }>({
    name: connection?.name ?? '',
    kind: connection?.kind ?? 'mysql',
    host: connection?.host ?? '127.0.0.1',
    port: connection?.port ?? 3306,
    user: connection?.user ?? 'root',
    password: '',
    database: connection?.database ?? '',
    ssl: connection?.ssl ?? false,
    safeMode: connection?.safeMode ?? true,
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const patch = (values: Partial<ConnectionDraft & { password: string }>) =>
    setDraft((current) => ({ ...current, ...values }));

  async function runTest() {
    setTesting(true);
    setMessage(null);
    try {
      const result = await api.testConnection({
        id: connection?.id,
        kind: draft.kind,
        host: draft.host,
        port: Number(draft.port),
        user: draft.user,
        ...(draft.password ? { password: draft.password } : {}),
        database: draft.database,
        ssl: draft.ssl,
      });
      setMessage({
        ok: true,
        text: `连接成功${result.version ? ` · 服务端版本 ${result.version}` : ''} · 可见 ${result.databaseCount} 个数据库`,
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const payload: Partial<ConnectionDraft> = {
        name: draft.name,
        kind: draft.kind,
        host: draft.host,
        port: Number(draft.port),
        user: draft.user,
        database: draft.database,
        ssl: draft.ssl,
        safeMode: draft.safeMode,
      };
      if (draft.password) payload.password = draft.password;
      else if (!isNew) payload.password = null;

      const result = isNew
        ? await api.createConnection(payload as ConnectionDraft)
        : await api.updateConnection(connection!.id, payload);
      onSaved(result.connection, isNew);
      onNotify(isNew ? '连接已保存' : '连接已更新');
      onClose();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!connection) return;
    if (!window.confirm(`确定删除连接「${connection.name}」？已保存的密码也会一并删除。`)) return;
    try {
      await api.deleteConnection(connection.id);
      onDeleted(connection.id);
      onNotify('连接已删除');
      onClose();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <Modal
      title={isNew ? '新建连接' : `编辑连接 · ${connection?.name}`}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button type="button" className="btn btn--danger" onClick={remove}>
              删除连接
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={runTest} disabled={testing || saving}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={saving || testing}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <label>连接名称</label>
          <input
            className="input"
            value={draft.name}
            placeholder="例如：本地 MySQL"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>
        <div className="field">
          <label>数据库类型</label>
          <select
            className="select"
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value as DbKind;
              setDraft((current) => ({ ...current, kind, port: DEFAULT_PORTS[kind] }));
            }}
          >
            <option value="mysql">MySQL / MariaDB</option>
            <option value="postgres">PostgreSQL</option>
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>主机地址</label>
          <input className="input" value={draft.host} onChange={(event) => patch({ host: event.target.value })} />
        </div>
        <div className="field">
          <label>端口</label>
          <input
            className="input"
            type="number"
            value={draft.port}
            onChange={(event) => patch({ port: Number(event.target.value) })}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>用户名</label>
          <input className="input" value={draft.user} onChange={(event) => patch({ user: event.target.value })} />
        </div>
        <div className="field">
          <label>密码</label>
          <input
            className="input"
            type="password"
            value={draft.password}
            placeholder={isNew ? '' : connection?.hasPassword ? '留空表示不修改' : '未保存密码'}
            onChange={(event) => patch({ password: event.target.value })}
          />
        </div>
      </div>

      <div className="field">
        <label>默认数据库（可留空，连接后再选）</label>
        <input
          className="input"
          value={draft.database ?? ''}
          onChange={(event) => patch({ database: event.target.value })}
        />
      </div>

      <label className="checkline">
        <input type="checkbox" checked={Boolean(draft.ssl)} onChange={(event) => patch({ ssl: event.target.checked })} />
        使用 SSL 加密连接
      </label>

      <label className="checkline">
        <input
          type="checkbox"
          checked={draft.safeMode !== false}
          onChange={(event) => patch({ safeMode: event.target.checked })}
        />
        安全模式：执行没有 WHERE 的 UPDATE / DELETE 前先弹出确认
      </label>

      {message && (
        <div className={message.ok ? 'panel-message panel-message--ok' : 'panel-message panel-message--error'}>
          {message.text}
        </div>
      )}

      <div style={{ color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.6 }}>
        密码使用本机密钥加密后保存在本机配置目录，不会上传到任何服务器。
      </div>
    </Modal>
  );
}

import { useEffect, useMemo, useState } from 'react'
import { AgentActivityEntry, AgentClientConfig, AgentIntegrationState } from '../types/svn'

interface Props {
  onClose: () => void
  toast: (message: string, type?: 'success' | 'error' | 'info') => void
}

function formatWhen(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function buildConfigText(config: AgentClientConfig | null): string {
  if (!config) return ''
  return JSON.stringify({
    mcpServers: {
      artisvn: config
    }
  }, null, 2)
}

export default function AgentIntegrationDialog({ onClose, toast }: Props) {
  const [state, setState] = useState<AgentIntegrationState | null>(null)
  const [config, setConfig] = useState<AgentClientConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const configText = useMemo(() => buildConfigText(config), [config])

  useEffect(() => {
    let mounted = true
    void window.agentIntegration.getState().then((next) => {
      if (mounted) setState(next)
    })
    const unsubState = window.agentIntegration.onState((next) => setState(next))
    const unsubActivity = window.agentIntegration.onActivity((activity) => {
      setState((current) => current ? { ...current, activity } : current)
    })
    return () => {
      mounted = false
      unsubState()
      unsubActivity()
    }
  }, [])

  useEffect(() => {
    if (!state?.enabled) {
      setConfig(null)
      return
    }
    void window.agentIntegration.getClientConfig().then(setConfig)
  }, [state?.enabled])

  const toggleEnabled = async () => {
    if (!state) return
    setBusy(true)
    try {
      setState(await window.agentIntegration.setEnabled(!state.enabled))
      toast(!state.enabled ? 'Integración IA activada' : 'Integración IA desactivada', 'success')
    } catch (error: any) {
      toast(error.message || 'No se pudo actualizar la integración IA', 'error')
    } finally {
      setBusy(false)
    }
  }

  const regenerateToken = async () => {
    const confirmed = confirm(
      '¿Regenerar el token MCP?\n\n' +
      'Las configuraciones que usen el token anterior dejarán de funcionar y las sesiones activas se cerrarán.'
    )
    if (!confirmed) return

    setBusy(true)
    try {
      setState(await window.agentIntegration.regenerateToken())
      setConfig(await window.agentIntegration.getClientConfig())
      toast('Token regenerado', 'success')
    } catch (error: any) {
      toast(error.message || 'No se pudo regenerar el token', 'error')
    } finally {
      setBusy(false)
    }
  }

  const copyConfig = async () => {
    if (!configText) return
    try {
      // The token never reaches the renderer: main copies the full configuration.
      await window.agentIntegration.copyClientConfig()
      toast('Configuración MCP copiada (incluye el token)', 'success')
    } catch {
      toast('No se pudo copiar la configuración', 'error')
    }
  }

  const clearActivity = async () => {
    try {
      const activity = await window.agentIntegration.clearActivity()
      setState((current) => current ? { ...current, activity } : current)
    } catch (error: any) {
      toast(error.message || 'No se pudo limpiar la actividad', 'error')
    }
  }

  const activity = state?.activity.slice().reverse() || []

  return (
    <div className="overlay">
      <div className="dialog agent-dialog">
        <div className="agent-header">
          <div>
            <div className="dialog-title">Integración IA</div>
            <div className="agent-header-meta">
              <span className={`agent-status-dot ${state?.brokerRunning ? 'active' : ''}`} />
              {state?.brokerRunning ? 'Broker local activo' : 'Broker local detenido'}
            </div>
          </div>
          <button
            className={`agent-toggle ${state?.enabled ? 'active' : ''}`}
            onClick={toggleEnabled}
            disabled={!state || busy}
            aria-label={state?.enabled ? 'Desactivar integración IA' : 'Activar integración IA'}
          >
            <span />
          </button>
        </div>

        <div className={`agent-state-banner ${state?.enabled ? 'active' : ''}`}>
          <div>
            <div className="agent-status-title">
              {state?.enabled ? 'Integración activada' : 'Integración desactivada'}
            </div>
            <div className="agent-muted">
              {state?.enabled
                ? state.brokerRunning ? 'Token activo' : 'Iniciando broker'
                : 'Token inactivo'}
            </div>
          </div>
          <span className="agent-state-chip">
            {state?.sessions.length || 0} {state?.sessions.length === 1 ? 'sesión' : 'sesiones'}
          </span>
        </div>

        <div className="agent-grid">
          <section className="agent-section">
            <div className="agent-section-head">
              <span>Clientes conectados</span>
              <span className="agent-pill">{state?.sessions.length || 0}</span>
            </div>
            <div className="agent-list">
              {state?.sessions.length ? state.sessions.map((session) => (
                <div key={session.id} className="agent-list-row">
                  <div>
                    <div>{session.clientName}</div>
                    <div className="agent-muted">{formatWhen(session.connectedAt)}</div>
                  </div>
                  {session.clientVersion && <span className="agent-muted">{session.clientVersion}</span>}
                </div>
              )) : (
                <div className="agent-empty">Sin clientes conectados</div>
              )}
            </div>
          </section>

          <section className="agent-section">
            <div className="agent-section-head">
              <span>Configuración MCP</span>
            </div>
            {configText ? (
              <pre className="agent-config">{configText}</pre>
            ) : (
              <div className="agent-config-empty">
                <div className="agent-config-empty-title">Sin configuración disponible</div>
                <div className="agent-muted">
                  {state?.enabled ? 'Generando configuración...' : 'Activa la integración para generarla.'}
                </div>
              </div>
            )}
            <div className="agent-actions-inline">
              <button className="btn btn-default" onClick={copyConfig} disabled={!configText}>
                Copiar
              </button>
              <button className="btn btn-default" onClick={regenerateToken} disabled={!state?.enabled || busy}>
                Regenerar token
              </button>
            </div>
          </section>
        </div>

        <section className="agent-section agent-activity">
          <div className="agent-section-head">
            <span>Actividad reciente</span>
            <button className="btn btn-ghost" onClick={clearActivity} disabled={activity.length === 0}>
              Limpiar
            </button>
          </div>
          <div className="agent-activity-list">
            {activity.length ? activity.map((entry: AgentActivityEntry) => (
              <div key={entry.id} className="agent-activity-row">
                <span className={`agent-activity-dot ${entry.ok ? 'ok' : 'error'}`} />
                <div className="agent-activity-main">
                  <div>{entry.clientName} · {entry.action}</div>
                  <div className="agent-muted">
                    {formatWhen(entry.at)}
                    {entry.target ? ` · ${entry.target}` : ''}
                    {typeof entry.durationMs === 'number' ? ` · ${entry.durationMs} ms` : ''}
                  </div>
                </div>
              </div>
            )) : (
              <div className="agent-empty">Sin actividad registrada</div>
            )}
          </div>
        </section>

        <div className="dialog-actions">
          <button className="btn btn-default" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}

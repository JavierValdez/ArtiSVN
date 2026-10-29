import { useState } from 'react'

interface Props {
  /** Resolves to null on success or to an error message (the dialog stays open). */
  onSave: (creds: { username: string; password: string; serverUrl: string }) => Promise<string | null>
  onCancel: () => void
  initialServerUrl?: string
  authError?: boolean
}

export default function AuthDialog({ onSave, onCancel, initialServerUrl = '', authError = false }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [serverUrl, setServerUrl] = useState(initialServerUrl)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.svn.pingWithCreds({ url: serverUrl, username, password })
      if (result.ok) {
        setTestResult({ ok: true, msg: 'Conexión exitosa ✓' })
      } else {
        setTestResult({ ok: false, msg: result.message || 'Error de conexión' })
      }
    } catch (err: any) {
      setTestResult({ ok: false, msg: err.message || 'Error' })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!username.trim() || saving) return

    setSaving(true)
    setSaveError(null)
    try {
      const error = await onSave({ username: username.trim(), password, serverUrl: serverUrl.trim() })
      if (error) {
        // Keep the form open (and the typed password) so the user can correct it.
        setSaveError(error)
        return
      }
      // Success: the dialog is closed by the parent; drop the password from component state.
      setPassword('')
    } catch (err: any) {
      setSaveError(err?.message || 'No se pudieron guardar las credenciales')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay">
      <div className="dialog">
        <div className="dialog-title">
          {authError ? '🔐 Credenciales invalidas' : '🔐 Conectar al servidor SVN'}
        </div>
        <div className="dialog-sub">
          {authError
            ? 'Tu contrasena puede haber cambiado. Ingresa tus credenciales nuevamente.'
            : 'Ingresa tus credenciales para acceder al repositorio SVN interno'}
        </div>

        <div className="form-field">
          <label className="form-label">URL del servidor</label>
          <input
            className="form-input"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://servidor/svn"
          />
        </div>

        <div className="form-field">
          <label className="form-label">Usuario</label>
          <input
            className="form-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="tu.usuario"
            autoFocus
          />
        </div>

        <div className="form-field">
          <label className="form-label">Contraseña</label>
          <input
            className="form-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
          />
        </div>

        {testResult && (
          <div style={{
            padding: '8px 12px',
            borderRadius: 6,
            background: testResult.ok ? '#dafbe1' : '#ffebe9',
            color: testResult.ok ? 'var(--success)' : 'var(--danger)',
            fontSize: 12,
            marginBottom: 8
          }}>
            {testResult.msg}
          </div>
        )}

        {saveError && (
          <div
            role="alert"
            className="auth-save-error"
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              background: '#ffebe9',
              color: 'var(--danger)',
              fontSize: 12,
              marginBottom: 8
            }}
          >
            {saveError}
          </div>
        )}

        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={handleTest} disabled={testing || !username || !serverUrl}>
            {testing ? 'Probando...' : 'Probar conexión'}
          </button>
          <button className="btn btn-default" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void handleSave()}
            disabled={!username.trim() || saving}
          >
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

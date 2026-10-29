import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildEnvWithExtraPath } from './svn-runtime'

export type SupportedEditorId = 'vscode' | 'vscode-insiders'

interface DetectedEditor {
  id: SupportedEditorId
  label: string
  command?: string
  macAppPath?: string
  winExecutablePath?: string
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(locator, [command], {
    env: buildEnvWithExtraPath(),
    stdio: 'ignore',
    windowsHide: true,
    timeout: 3000
  })
  return !result.error && result.status === 0
}

function firstExistingPath(paths: string[]): string | undefined {
  for (const path of paths) {
    if (path && existsSync(path)) return path
  }
  return undefined
}

export function detectEditors(): DetectedEditor[] {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

  const definitions: Array<{
    id: SupportedEditorId
    label: string
    command: string
    macAppName: string
    winCandidates: string[]
  }> = [
    {
      id: 'vscode',
      label: 'VS Code',
      command: 'code',
      macAppName: 'Visual Studio Code.app',
      winCandidates: [
        join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        join(programFiles, 'Microsoft VS Code', 'Code.exe'),
        join(programFilesX86, 'Microsoft VS Code', 'Code.exe')
      ]
    },
    {
      id: 'vscode-insiders',
      label: 'VS Code Insiders',
      command: 'code-insiders',
      macAppName: 'Visual Studio Code - Insiders.app',
      winCandidates: [
        join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
        join(programFiles, 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
        join(programFilesX86, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')
      ]
    }
  ]

  return definitions
    .map((editor) => {
      const command = commandExists(editor.command) ? editor.command : undefined
      const macAppPath = process.platform === 'darwin'
        ? firstExistingPath([
          join('/Applications', editor.macAppName),
          join(homedir(), 'Applications', editor.macAppName)
        ])
        : undefined
      const winExecutablePath = process.platform === 'win32'
        ? firstExistingPath(editor.winCandidates)
        : undefined

      if (!command && !macAppPath && !winExecutablePath) return null
      return {
        id: editor.id,
        label: editor.label,
        command,
        macAppPath,
        winExecutablePath
      } as DetectedEditor
    })
    .filter((x): x is DetectedEditor => x !== null)
}

function buildEditorLaunchEnv(): NodeJS.ProcessEnv {
  const env = { ...buildEnvWithExtraPath() }

  // Avoid leaking Electron/VS Code process state into a fresh VS Code launch.
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_ENABLE_LOGGING' || key === 'ELECTRON_ENABLE_STACK_DUMPING') continue
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
      delete env[key]
    }
  }

  return env
}

function runCommand(command: string, args: string[], options: { shell?: boolean } = {}): boolean {
  try {
    const proc = spawn(command, args, {
      env: buildEditorLaunchEnv(),
      stdio: 'ignore',
      windowsHide: true,
      shell: options.shell || false,
      detached: true
    })

    proc.unref()
    return Boolean(proc.pid)
  } catch {
    return false
  }
}

export function openRepoInEditor(editorId: SupportedEditorId, repoPath: string): void {
  const safePath = (repoPath || '').trim()
  if (!safePath) throw new Error('Ruta de repositorio inválida')
  if (!existsSync(safePath)) throw new Error('El repositorio no existe')
  if (!statSync(safePath).isDirectory()) throw new Error('La ruta no es una carpeta')

  const editor = detectEditors().find((x) => x.id === editorId)
  if (!editor) throw new Error('Ese editor no está disponible en este equipo')

  // On Windows, prefer launching the detected .exe directly to avoid shell arg splitting
  // when repository paths contain spaces.
  if (process.platform === 'win32') {
    if (editor.winExecutablePath && runCommand(editor.winExecutablePath, [safePath])) return
    // The shell fallback goes through cmd.exe: refuse paths with cmd metacharacters.
    if (editor.command && !/[&|<>^%!"]/.test(safePath) && runCommand(editor.command, [`"${safePath}"`], { shell: true })) return
  } else {
    if (editor.command && runCommand(editor.command, [safePath])) return
    if (process.platform === 'darwin' && editor.macAppPath && runCommand('open', ['-a', editor.macAppPath, safePath])) return
  }

  throw new Error(`No se pudo abrir el repositorio en ${editor.label}`)
}

/**
 * dsh-plugin-zcode-import — Client half.
 *
 * Adds a “会话导入 / Session import” page to the Settings panel
 * (`settings.section`). The page lists the ZCode workspaces found by the host
 * half, then the conversations of the selected workspace, and imports either a
 * checked subset or the whole workspace into this DSH profile.
 *
 * Layout follows the host theme tokens; every visible string goes through the
 * Client locale service with a built-in zh/en dictionary as the fallback.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-zcode-import',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'zcode-session-import'
    const API = '/zcode-import/api'
    const POLL_MS = 700

    const DICTS = {
      zh: {
        sectionLabel: '会话导入',
        title: '会话导入',
        intro: '从本地 ZCode 导入会话：先在左侧选择工作区，再勾选部分对话或直接导入整个工作区。导入后的会话会出现在左侧会话列表中。',
        rootLabel: 'ZCode 数据目录：{path}',
        dbMissing: '未找到 ZCode 数据库：{path}',
        workspaces: 'ZCode 工作区',
        refresh: '刷新',
        scanning: '正在扫描…',
        noWorkspaces: '未找到 ZCode 工作区',
        chatsBadge: '{n} 个会话',
        dirMissing: '目录不存在',
        updatedAt: '最近更新 {time}',
        chats: 'ZCode 对话',
        chatsOf: '对话 · {name}',
        selectAll: '全选未导入',
        clearAll: '取消全选',
        pickWorkspace: '请先在左侧选择一个工作区',
        loadingChats: '正在读取对话列表…',
        noChats: '该工作区没有对话',
        imported: '已导入',
        meta: '{time} · {n} 条消息',
        subagentTag: ' · 子代理',
        selected: '已选 {n} 个会话',
        importSelected: '导入选中会话',
        importAll: '导入整个工作区',
        importAllHint: '导入该工作区的全部 ZCode 对话',
        running: '正在导入 {done}/{total} · {current}',
        results: '导入明细',
        ok: '已导入',
        exists: '已存在',
        skipped: '跳过',
        failed: '失败',
        hostDown: '宿主插件未响应，请刷新页面后重试',
        httpError: 'HTTP {status}',
        done: '导入完成：新增 {imported} 个会话，跳过 {skipped} 个，失败 {failed} 个',
        jobError: '导入失败：{message}',
        jobPollFailed: '导入状态查询失败：{message}',
        startFailed: '无法启动导入：{message}',
        noContent: '没有可导入的对话内容',
      },
      en: {
        sectionLabel: 'Session import',
        title: 'Session import',
        intro:
          'Import conversations from the local ZCode installation: pick a workspace on the left, then check individual chats or import the whole workspace. Imported chats appear in the sidebar session list.',
        rootLabel: 'ZCode data root: {path}',
        dbMissing: 'ZCode database not found: {path}',
        workspaces: 'ZCode workspaces',
        refresh: 'Refresh',
        scanning: 'Scanning…',
        noWorkspaces: 'No ZCode workspace found',
        chatsBadge: '{n} chats',
        dirMissing: 'directory missing',
        updatedAt: 'updated {time}',
        chats: 'ZCode chats',
        chatsOf: 'Chats · {name}',
        selectAll: 'Select all new',
        clearAll: 'Clear selection',
        pickWorkspace: 'Pick a workspace on the left first',
        loadingChats: 'Loading chats…',
        noChats: 'No chat in this workspace',
        imported: 'imported',
        meta: '{time} · {n} messages',
        subagentTag: ' · subagent',
        selected: '{n} selected',
        importSelected: 'Import selected',
        importAll: 'Import whole workspace',
        importAllHint: 'Import every ZCode chat of this workspace',
        running: 'Importing {done}/{total} · {current}',
        results: 'Import detail',
        ok: 'imported',
        exists: 'exists',
        skipped: 'skipped',
        failed: 'failed',
        hostDown: 'The host plugin did not respond — reload the page and try again',
        httpError: 'HTTP {status}',
        done: 'Import finished: {imported} added, {skipped} skipped, {failed} failed',
        jobError: 'Import failed: {message}',
        jobPollFailed: 'Could not read the import status: {message}',
        startFailed: 'Could not start the import: {message}',
        noContent: 'nothing importable in this conversation',
      },
    }

    const runtime = { dict: DICTS.en, translate: null }

    /** Locale service captured at apply time, for render-time subscriptions. */
    let localeService = null

    /**
     * Translate one key through the locale service when it is wired, and through
     * the built-in dictionaries otherwise. The service-bound translator reads
     * the active locale at call time, so this function stays correct across a
     * language switch without being recreated.
     *
     * @param key - dictionary key in this page's namespace.
     * @param vars - optional `{name}` interpolation values.
     * @returns the translated text.
     */
    function t(key, vars) {
      const translate = runtime.translate
      if (translate !== null) return translate(key, vars)
      const template = runtime.dict[key] ?? DICTS.en[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        vars[name] === undefined ? match : String(vars[name]),
      )
    }

    /**
     * Re-render the caller on every locale change: the page's strings come from
     * the bound translator, which already reads the active locale, so one render
     * is all a language switch needs.
     */
    function useLocaleRevision() {
      const [, setRevision] = useState(0)
      useEffect(() => {
        const service = localeService
        if (service === null || typeof service.subscribe !== 'function') return undefined
        return service.subscribe(() => setRevision((value) => value + 1))
      }, [])
    }

    // --------------------------------------------------------------- helpers

    async function api(method, payload) {
      const init = { method: 'GET', credentials: 'same-origin' }
      if (payload !== undefined) {
        init.method = 'POST'
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(payload)
      }
      let response
      try {
        response = await fetch(API + '/' + method, init)
      } catch {
        throw new Error(t('hostDown'))
      }
      let parsed = null
      try {
        parsed = await response.json()
      } catch {
        parsed = null
      }
      if (!parsed || parsed.ok !== true) {
        const message =
          (parsed && parsed.error && parsed.error.message) || t('httpError', { status: response.status })
        throw new Error(message)
      }
      return parsed.value
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes())
      )
    }

    const COLOR = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', color: COLOR.text, fontSize: '13px', lineHeight: 1.5 },
      head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      hint: { color: COLOR.muted, fontSize: '12px' },
      // Buttons follow the shell's own control styles
      // (dsh-client-ui-primitives Button.module.css): `buttonBase` is the 28px
      // `sm` variant and `buttonBaseMd` the 36px `md` one. Both variants use the
      // dedicated button tokens instead of the brand accent —
      // `--dsw-alias-brand-primary` is near-white in the dark theme, so pairing
      // it with fixed white text paints an unreadable button.
      buttonBase: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        color: COLOR.text,
        background: 'transparent',
        cursor: 'pointer',
      },
      buttonBaseMd: {
        height: '36px',
        padding: '0 14px',
        borderRadius: 'var(--dsw-radius-md)',
        fontSize: '14px',
        lineHeight: '22px',
      },
      buttonOutline: { border: '0.5px solid var(--dsw-alias-border-l3)' },
      buttonHover: { background: 'var(--dsw-alias-interactive-bg-hover)' },
      buttonPrimary: {
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
      },
      buttonPrimaryHover: { background: 'var(--dsw-alias-button-primary-hover)' },
      buttonDisabled: { opacity: 0.4, cursor: 'not-allowed' },
      columns: { display: 'flex', gap: '12px', flexWrap: 'wrap', minHeight: '320px', height: 'min(56vh, 540px)' },
      column: {
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid ' + COLOR.border,
        borderRadius: '8px',
        background: COLOR.layer1,
        overflow: 'hidden',
      },
      columnHead: {
        padding: '8px 10px',
        borderBottom: '1px solid ' + COLOR.border,
        fontSize: '12px',
        fontWeight: 600,
        color: COLOR.muted,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
      },
      list: { overflowY: 'auto', flex: 1 },
      wsItem: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderBottom: '1px solid ' + COLOR.border,
        background: 'transparent',
        color: COLOR.text,
        padding: '8px 10px',
        cursor: 'pointer',
        font: 'inherit',
      },
      wsItemActive: { background: COLOR.layer2, boxShadow: 'inset 2px 0 0 ' + COLOR.brand },
      wsTitle: { fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' },
      wsPath: { color: COLOR.muted, fontSize: '11px', wordBreak: 'break-all', display: 'block' },
      row: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '7px 10px', borderBottom: '1px solid ' + COLOR.border, cursor: 'pointer' },
      rowTitle: { flex: 1, minWidth: 0 },
      rowLine: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: '10px',
        borderRadius: '999px',
        padding: '1px 6px',
        border: '1px solid ' + COLOR.border2,
        color: COLOR.muted,
        whiteSpace: 'nowrap',
      },
      badgeDone: { borderColor: COLOR.success, color: COLOR.success },
      toolbar: {
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '8px 10px',
        border: '1px solid ' + COLOR.border,
        borderRadius: '8px',
        background: COLOR.layer1,
      },
      progressOuter: { height: '6px', borderRadius: '999px', background: COLOR.layer2, overflow: 'hidden', flex: 1, minWidth: '120px' },
      progressInner: { height: '100%', background: COLOR.brand, transition: 'width .2s linear' },
      empty: { padding: '18px', color: COLOR.muted, textAlign: 'center' },
      error: { color: COLOR.error, fontSize: '12px' },
      results: { maxHeight: '150px', overflowY: 'auto', fontSize: '12px' },
      resultRow: { display: 'flex', gap: '8px', padding: '2px 0', alignItems: 'baseline' },
    }

    /**
     * One shell-styled button.
     *
     * Inline styles cannot express `:hover`, so the two hover fills the shell
     * uses are tracked in state instead of a stylesheet.
     *
     * @param props - `variant` ('primary' | 'outline'), `size` ('sm' | 'md'),
     *   plus `disabled`, `title`, `onClick` and `style`.
     * @returns the button element.
     */
    function Button(props) {
      const [hover, setHover] = useState(false)
      const primary = props.variant === 'primary'
      const enabled = props.disabled !== true
      const style = Object.assign(
        {},
        styles.buttonBase,
        props.size === 'md' ? styles.buttonBaseMd : null,
        primary ? styles.buttonPrimary : styles.buttonOutline,
        hover && enabled ? (primary ? styles.buttonPrimaryHover : styles.buttonHover) : null,
        enabled ? null : styles.buttonDisabled,
        props.style,
      )
      return h(
        'button',
        {
          type: 'button',
          style,
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        props.children,
      )
    }

    // ------------------------------------------------------------------ page

    function ImportPage() {
      useLocaleRevision()
      const [status, setStatus] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [loadingWorkspaces, setLoadingWorkspaces] = useState(true)
      const [error, setError] = useState(null)
      const [selectedPath, setSelectedPath] = useState(null)
      const [sessions, setSessions] = useState([])
      const [loadingSessions, setLoadingSessions] = useState(false)
      const [checked, setChecked] = useState(() => new Set())
      const [job, setJob] = useState(null)
      const [notice, setNotice] = useState(null)
      const jobTimer = useRef(null)

      const loadWorkspaces = useCallback(async () => {
        setLoadingWorkspaces(true)
        setError(null)
        try {
          const [statusValue, list] = await Promise.all([api('status'), api('workspaces')])
          setStatus(statusValue)
          setWorkspaces(Array.isArray(list.workspaces) ? list.workspaces : [])
        } catch (err) {
          setError(err.message)
          setWorkspaces([])
        } finally {
          setLoadingWorkspaces(false)
        }
      }, [])

      const loadSessions = useCallback(async (path) => {
        if (path === null) return
        setLoadingSessions(true)
        setError(null)
        setChecked(new Set())
        try {
          const value = await api('sessions?path=' + encodeURIComponent(path))
          setSessions(Array.isArray(value.sessions) ? value.sessions : [])
        } catch (err) {
          setError(err.message)
          setSessions([])
        } finally {
          setLoadingSessions(false)
        }
      }, [])

      useEffect(() => {
        void loadWorkspaces()
      }, [loadWorkspaces])

      useEffect(() => {
        if (selectedPath !== null) void loadSessions(selectedPath)
      }, [selectedPath, loadSessions])

      useEffect(
        () => () => {
          if (jobTimer.current !== null) window.clearInterval(jobTimer.current)
        },
        [],
      )

      const stopPolling = useCallback(() => {
        if (jobTimer.current !== null) {
          window.clearInterval(jobTimer.current)
          jobTimer.current = null
        }
      }, [])

      const pollJob = useCallback(
        async (jobId) => {
          try {
            const value = await api('job?id=' + encodeURIComponent(jobId))
            setJob(value)
            if (value.state === 'done' || value.state === 'error') {
              stopPolling()
              setNotice(
                value.state === 'error'
                  ? t('jobError', { message: value.error || '' })
                  : t('done', { imported: value.imported, skipped: value.skipped, failed: value.failed }),
              )
              if (selectedPath !== null) await loadSessions(selectedPath)
              void loadWorkspaces()
            }
          } catch (err) {
            stopPolling()
            setNotice(t('jobPollFailed', { message: err.message }))
          }
        },
        [loadSessions, loadWorkspaces, selectedPath, stopPolling],
      )

      const startImport = useCallback(
        async (sessionIds) => {
          if (selectedPath === null) return
          setNotice(null)
          try {
            const value = await api('import', { path: selectedPath, sessionIds })
            setJob({ id: value.jobId, state: 'running', total: 0, done: 0, results: [] })
            stopPolling()
            jobTimer.current = window.setInterval(() => void pollJob(value.jobId), POLL_MS)
            void pollJob(value.jobId)
          } catch (err) {
            setNotice(t('startFailed', { message: err.message }))
          }
        },
        [pollJob, selectedPath, stopPolling],
      )

      const toggle = useCallback((id) => {
        setChecked((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      const selectable = useMemo(() => sessions.filter((item) => item.imported !== true), [sessions])
      const running = job !== null && job.state === 'running'
      const percent = running && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : running ? 4 : 0
      const selectedWorkspace = workspaces.find((item) => item.path === selectedPath) ?? null
      const allImported = selectedWorkspace !== null && sessions.length > 0 && selectable.length === 0

      const workspaceColumn = h(
        'div',
        { style: Object.assign({}, styles.column, { flex: '1 1 36%', minWidth: '200px' }) },
        h(
          'div',
          { style: styles.columnHead },
          h('span', null, t('workspaces')),
          h(
            Button,
            { onClick: () => void loadWorkspaces(), disabled: loadingWorkspaces },
            t('refresh'),
          ),
        ),
        h(
          'div',
          { style: styles.list },
          loadingWorkspaces
            ? h('div', { style: styles.empty }, t('scanning'))
            : workspaces.length === 0
              ? h('div', { style: styles.empty }, t('noWorkspaces'))
              : workspaces.map((item) =>
                  h(
                    'button',
                    {
                      key: item.path,
                      style: Object.assign({}, styles.wsItem, item.path === selectedPath ? styles.wsItemActive : {}),
                      onClick: () => setSelectedPath(item.path),
                      title: item.path,
                    },
                    h(
                      'span',
                      { style: styles.wsTitle },
                      h('span', { style: styles.rowLine }, item.title),
                      h('span', { style: styles.badge }, t('chatsBadge', { n: item.sessions })),
                      item.exists
                        ? null
                        : h(
                            'span',
                            { style: Object.assign({}, styles.badge, { color: COLOR.warn, borderColor: COLOR.warn }) },
                            t('dirMissing'),
                          ),
                    ),
                    h('span', { style: styles.wsPath }, item.path),
                    h('span', { style: styles.wsPath }, t('updatedAt', { time: formatTime(item.updated) })),
                  ),
                ),
        ),
      )

      const sessionColumn = h(
        'div',
        { style: Object.assign({}, styles.column, { flex: '1 1 56%', minWidth: '260px' }) },
        h(
          'div',
          { style: styles.columnHead },
          h('span', { style: styles.rowLine }, selectedWorkspace === null ? t('chats') : t('chatsOf', { name: selectedWorkspace.title })),
          h(
            Button,
            {
              disabled: sessions.length === 0,
              onClick: () => setChecked(new Set(checked.size === selectable.length ? [] : selectable.map((item) => item.id))),
            },
            checked.size === selectable.length && selectable.length > 0 ? t('clearAll') : t('selectAll'),
          ),
        ),
        h(
          'div',
          { style: styles.list },
          selectedPath === null
            ? h('div', { style: styles.empty }, t('pickWorkspace'))
            : loadingSessions
              ? h('div', { style: styles.empty }, t('loadingChats'))
              : sessions.length === 0
                ? h('div', { style: styles.empty }, t('noChats'))
                : sessions.map((item) =>
                    h(
                      'label',
                      { key: item.id, style: styles.row },
                      h('input', {
                        type: 'checkbox',
                        checked: checked.has(item.id),
                        onChange: () => toggle(item.id),
                        style: { marginTop: '2px' },
                      }),
                      h(
                        'span',
                        { style: styles.rowTitle },
                        h(
                          'span',
                          { style: Object.assign({}, styles.rowLine, { fontWeight: 600 }) },
                          item.title || item.id,
                        ),
                        h(
                          'span',
                          { style: Object.assign({}, styles.wsPath, styles.rowLine) },
                          t('meta', { time: formatTime(item.updated), n: item.messages }) +
                            (item.taskType === 'subagent_child' ? t('subagentTag') : ''),
                        ),
                      ),
                      item.imported
                        ? h('span', { style: Object.assign({}, styles.badge, styles.badgeDone) }, t('imported'))
                        : null,
                    ),
                  ),
        ),
      )

      const toolbar = h(
        'div',
        { style: styles.toolbar },
        h('span', { style: styles.hint }, t('selected', { n: checked.size })),
        h(
          Button,
          {
            variant: 'primary',
            size: 'md',
            disabled: checked.size === 0 || running,
            onClick: () => void startImport(Array.from(checked)),
          },
          t('importSelected'),
        ),
        h(
          Button,
          {
            size: 'md',
            disabled: selectedPath === null || running || allImported,
            onClick: () => void startImport([]),
            title: t('importAllHint'),
          },
          t('importAll'),
        ),
        running
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { style: styles.progressOuter },
                h('div', { style: Object.assign({}, styles.progressInner, { width: percent + '%' }) }),
              ),
              h(
                'span',
                { style: styles.hint },
                t('running', { done: job.done, total: job.total || '?', current: job.current || '' }),
              ),
            )
          : null,
      )

      const results =
        job === null || !Array.isArray(job.results) || job.results.length === 0
          ? null
          : h(
              'div',
              { style: { border: '1px solid ' + COLOR.border, borderRadius: '8px', padding: '8px 10px' } },
              h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, t('results')),
              h(
                'div',
                { style: styles.results },
                job.results.map((item, index) =>
                  h(
                    'div',
                    { key: (item.sourceId || 'r') + index, style: styles.resultRow },
                    h(
                      'span',
                      { style: { color: item.ok ? COLOR.success : COLOR.warn, minWidth: '52px' } },
                      item.ok ? (item.alreadyImported ? t('exists') : t('ok')) : item.skipped ? t('skipped') : t('failed'),
                    ),
                    h('span', { style: styles.rowLine }, item.title || item.sourceId || item.sessionId || ''),
                    item.reason ? h('span', { style: styles.error }, item.reason) : null,
                  ),
                ),
              ),
            )

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.head },
          h('h2', { style: styles.title }, t('title')),
          h(
            'span',
            { style: styles.hint },
            status === null ? '' : t(status.available ? 'rootLabel' : 'dbMissing', { path: status.available ? status.root : status.database }),
          ),
        ),
        h('span', { style: styles.hint }, t('intro')),
        error !== null ? h('div', { style: styles.error }, error) : null,
        notice !== null ? h('div', { style: { color: COLOR.muted, fontSize: '12px' } }, notice) : null,
        toolbar,
        h('div', { style: styles.columns }, workspaceColumn, sessionColumn),
        results,
      )
    }

    const page = ImportPage

    /**
     * Register this page's zh/en dictionaries with the Client locale service and
     * bind a translator to them.
     *
     * One call registers every locale (`register(ns, dicts)`), which is the
     * single-occupant form the service documents for a namespace's own texts.
     * The bound translator reads the active locale at call time, so nothing here
     * has to track the active language by hand; `runtime.dict` stays as the
     * fallback for a host whose locale service is missing.
     *
     * @param ctx - client cordis context (its `locale` service is a dependency).
     */
    function installLocale(ctx) {
      const locale = ctx.locale ?? ctx.get('locale')
      if (!locale || typeof locale.register !== 'function') return
      localeService = locale
      if (typeof locale.bind === 'function') runtime.translate = locale.bind(NS)
      // Registration bumps the locale revision, which is what makes outlets that
      // rendered before the dictionaries arrived pick them up.
      ctx.effect(() => locale.register(NS, { zh: DICTS.zh, en: DICTS.en }), 'zcode-import: dictionaries')
    }

    /**
     * Register the Settings section entry.
     *
     * The nav label is a thunk, but the shell only re-projects a section when its
     * ledger changes, so a language switch rebuilds the entry: dispose the old
     * registration and install a fresh one whose label reads the new locale.
     *
     * @param ctx - client cordis context.
     * @returns a rebuild function for locale changes.
     */
    function installSection(ctx) {
      let dispose = null
      const mount = () => {
        if (dispose !== null) dispose()
        dispose = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'zcode-import',
              order: 30,
              label: () => t('sectionLabel'),
            },
            page,
          ),
        )
      }
      mount()
      return mount
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        installLocale(ctx)
        const rebuildSection = installSection(ctx)
        ctx.effect(() => {
          const service = localeService
          if (service === null || typeof service.subscribe !== 'function') return undefined
          return service.subscribe(rebuildSection)
        }, 'zcode-import: localized section label')
      },
    }
  },
})

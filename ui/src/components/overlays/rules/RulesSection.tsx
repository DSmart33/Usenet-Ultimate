// What this does:
//   Rules section inside the Filters overlay. Renders the ranked-rule editors
//   (regex rules, SEL rules), an import dialog, and a live-test field. Regex
//   rules support three modes: 'score' (positive boosts, negative penalizes;
//   default), 'keep' (include filter — only matching candidates survive), and
//   'drop' (exclude filter — matching candidates are removed). SEL rules are
//   score-only. The `regexScore` and `seScore` sort methods consume scores.
//
//   Each rule list (Regex / SEL) supports drag-and-drop reorder via a dedicated
//   GripVertical handle (mouse/touch) plus chevron up/down for keyboard. Each
//   list also has Select All / Deselect All and a Delete Selected (N) button
//   gated by a confirmation modal — bulk operations live alongside per-row
//   edits.
//
// Architecture note:
//   The section receives the per-type `rules` block and an updater. All edits
//   update the parent FiltersState in place; the existing debounced save hook
//   persists via PUT /api/settings. The server validates every regex and SEL
//   expression at save time and returns 400 on ReDoS / bad SEL. We surface
//   that error inline so the user knows why the save was rejected.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, ChevronUp, ChevronDown, Upload, AlertCircle, FlaskConical, X, ChevronLeft, GripVertical } from 'lucide-react';
import clsx from 'clsx';
import type { RulesBlock, RankedRegexRule, RankedSelRule } from '../../../types';

// Pinned to v2.5.2 at commit da9464e1. Newer Tamtaro templates are currently incompatibile
const PINNED_TAMTARO_URL =
  'https://raw.githubusercontent.com/Tam-Taro/SEL-Filtering-and-Sorting/da9464e1ad13ea7e4533abcdf09ca6b405e74905/AIOStreams%20Templates/Tamtaro-complete-setup-template.json';

// ─── Props ───────────────────────────────────────────────────────────

interface RulesSectionProps {
  rules: RulesBlock | undefined;
  onChange: (next: RulesBlock) => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  disabled?: boolean;
}

function newId(): string {
  // uuid-lite. The server generates proper UUIDs on import; client-added rules
  // only need stable identity within this session.
  return 'r_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ─── Regex rule row (memoized — keyed by rule.id) ────────────────────

interface RegexRuleRowProps {
  rule: RankedRegexRule;
  onUpdate: (patch: Partial<RankedRegexRule>) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDragOver: boolean;
  disabled?: boolean;
}

const RegexRuleRow = memo(function RegexRuleRow({
  rule, onUpdate, onDelete, onMoveUp, onMoveDown, canMoveUp, canMoveDown,
  selected, onToggleSelect, onDragStart, onDragOver, onDrop, onDragEnd,
  isDragging, isDragOver, disabled,
}: RegexRuleRowProps) {
  const enabled = rule.enabled !== false;
  const mode = rule.mode ?? 'score';
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      className={clsx(
        "p-3 rounded-lg border bg-slate-800/40 space-y-2 transition-all",
        enabled ? "border-slate-700/50" : "border-slate-700/30 opacity-60",
        isDragging && "opacity-50",
        isDragOver && "ring-2 ring-purple-400"
      )}
    >
      <div className="flex items-start gap-2">
        <div
          draggable={!disabled}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label="Drag to reorder"
          tabIndex={-1}
          className={clsx(
            "pt-1 text-slate-500 hover:text-slate-300 shrink-0",
            disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
          )}
        >
          <GripVertical className="w-4 h-4" />
        </div>
        <div className="pt-1.5 shrink-0">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            disabled={disabled}
            aria-label={`Select rule ${rule.name || ''}`}
            className="w-4 h-4 accent-purple-500 cursor-pointer"
          />
        </div>
        <div className="flex flex-col gap-0.5 pt-1">
          <button
            type="button"
            aria-label={`Move ${rule.name || 'rule'} up`}
            onClick={onMoveUp}
            disabled={!canMoveUp || disabled}
            className="p-0.5 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Move ${rule.name || 'rule'} down`}
            onClick={onMoveDown}
            disabled={!canMoveDown || disabled}
            className="p-0.5 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-col sm:flex-row gap-1.5">
            <div className="flex-1 min-w-0">
              <label htmlFor={`rx-name-${rule.id}`} className="sr-only">Rule name</label>
              <input
                id={`rx-name-${rule.id}`}
                type="text"
                value={rule.name}
                placeholder="Rule name"
                onChange={(e) => onUpdate({ name: e.target.value })}
                disabled={disabled}
                className="w-full px-2 py-1 text-sm bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              />
            </div>
            <div className="flex gap-1.5">
              {mode === 'score' ? (
                <div className="w-20">
                  <label htmlFor={`rx-score-${rule.id}`} className="sr-only">Score</label>
                  <input
                    id={`rx-score-${rule.id}`}
                    type="number"
                    inputMode="numeric"
                    min={-10000}
                    max={10000}
                    step={1}
                    value={rule.score}
                    onChange={(e) => onUpdate({ score: clamp(parseInt(e.target.value || '0', 10) || 0, -10000, 10000) })}
                    disabled={disabled}
                    className="w-full px-2 py-1 text-sm bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                  />
                </div>
              ) : (
                <div
                  className={clsx(
                    "w-20 px-2 py-1 text-xs font-medium uppercase tracking-wide rounded border flex items-center justify-center",
                    mode === 'keep'
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                      : "bg-red-500/15 border-red-500/40 text-red-300"
                  )}
                >
                  {mode === 'keep' ? 'Keep' : 'Drop'}
                </div>
              )}
              <button
                type="button"
                aria-label={enabled ? 'Disable rule' : 'Enable rule'}
                onClick={() => onUpdate({ enabled: !enabled })}
                disabled={disabled}
                className={clsx(
                  "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                  enabled ? "bg-purple-500" : "bg-slate-600"
                )}
              >
                <div className={clsx(
                  "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                  enabled ? "left-5" : "left-1"
                )} />
              </button>
              <button
                type="button"
                aria-label={`Delete rule ${rule.name || ''}`}
                onClick={onDelete}
                disabled={disabled}
                className="p-1.5 text-slate-400 hover:text-red-400"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor={`rx-mode-${rule.id}`} className="text-[11px] text-slate-400 whitespace-nowrap">Mode:</label>
            <select
              id={`rx-mode-${rule.id}`}
              value={mode}
              onChange={(e) => onUpdate({ mode: e.target.value as 'score' | 'keep' | 'drop' })}
              disabled={disabled}
              className="px-2 py-1 text-xs bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
            >
              <option value="score">Score</option>
              <option value="keep">Keep matches</option>
              <option value="drop">Drop matches</option>
            </select>
          </div>
          <div className="flex gap-1.5">
            <div className="flex-1 min-w-0">
              <label htmlFor={`rx-pat-${rule.id}`} className="block text-[10px] text-slate-500 mb-0.5">Pattern</label>
              <input
                id={`rx-pat-${rule.id}`}
                type="text"
                value={rule.pattern}
                placeholder="regex source, no / / wrapping"
                onChange={(e) => onUpdate({ pattern: e.target.value })}
                disabled={disabled}
                className="w-full px-2 py-1 text-xs font-mono bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              />
            </div>
            <div className="w-16">
              <label htmlFor={`rx-flags-${rule.id}`} className="block text-[10px] text-slate-500 mb-0.5">Flags</label>
              <input
                id={`rx-flags-${rule.id}`}
                type="text"
                value={rule.flags ?? ''}
                placeholder="i g m"
                onChange={(e) => onUpdate({ flags: e.target.value })}
                disabled={disabled}
                className="w-full px-2 py-1 text-xs font-mono bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── SEL rule row (memoized) ─────────────────────────────────────────

interface SelRuleRowProps {
  rule: RankedSelRule;
  onUpdate: (patch: Partial<RankedSelRule>) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDragOver: boolean;
  disabled?: boolean;
}

const SelRuleRow = memo(function SelRuleRow({
  rule, onUpdate, onDelete, onMoveUp, onMoveDown, canMoveUp, canMoveDown,
  selected, onToggleSelect, onDragStart, onDragOver, onDrop, onDragEnd,
  isDragging, isDragOver, disabled,
}: SelRuleRowProps) {
  const enabled = rule.enabled !== false;
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      className={clsx(
        "p-3 rounded-lg border bg-slate-800/40 space-y-2 transition-all",
        enabled ? "border-slate-700/50" : "border-slate-700/30 opacity-60",
        isDragging && "opacity-50",
        isDragOver && "ring-2 ring-purple-400"
      )}
    >
      <div className="flex items-start gap-2">
        <div
          draggable={!disabled}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label="Drag to reorder"
          tabIndex={-1}
          className={clsx(
            "pt-1 text-slate-500 hover:text-slate-300 shrink-0",
            disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
          )}
        >
          <GripVertical className="w-4 h-4" />
        </div>
        <div className="pt-1.5 shrink-0">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            disabled={disabled}
            aria-label={`Select rule ${rule.name || ''}`}
            className="w-4 h-4 accent-purple-500 cursor-pointer"
          />
        </div>
        <div className="flex flex-col gap-0.5 pt-1">
          <button
            type="button"
            aria-label={`Move ${rule.name || 'rule'} up`}
            onClick={onMoveUp}
            disabled={!canMoveUp || disabled}
            className="p-0.5 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Move ${rule.name || 'rule'} down`}
            onClick={onMoveDown}
            disabled={!canMoveDown || disabled}
            className="p-0.5 rounded text-slate-400 hover:text-slate-200 disabled:opacity-30"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-col sm:flex-row gap-1.5">
            <div className="flex-1 min-w-0">
              <label htmlFor={`sel-name-${rule.id}`} className="sr-only">Rule name</label>
              <input
                id={`sel-name-${rule.id}`}
                type="text"
                value={rule.name}
                placeholder="Rule name"
                onChange={(e) => onUpdate({ name: e.target.value })}
                disabled={disabled}
                className="w-full px-2 py-1 text-sm bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              />
            </div>
            <div className="flex gap-1.5">
              <div className="w-20">
                <label htmlFor={`sel-score-${rule.id}`} className="sr-only">Score</label>
                <input
                  id={`sel-score-${rule.id}`}
                  type="number"
                  inputMode="numeric"
                  min={-10000}
                  max={10000}
                  step={1}
                  value={rule.score}
                  onChange={(e) => onUpdate({ score: clamp(parseInt(e.target.value || '0', 10) || 0, -10000, 10000) })}
                  disabled={disabled}
                  className="w-full px-2 py-1 text-sm bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                />
              </div>
              <button
                type="button"
                aria-label={enabled ? 'Disable rule' : 'Enable rule'}
                onClick={() => onUpdate({ enabled: !enabled })}
                disabled={disabled}
                className={clsx(
                  "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                  enabled ? "bg-purple-500" : "bg-slate-600"
                )}
              >
                <div className={clsx(
                  "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                  enabled ? "left-5" : "left-1"
                )} />
              </button>
              <button
                type="button"
                aria-label={`Delete rule ${rule.name || ''}`}
                onClick={onDelete}
                disabled={disabled}
                className="p-1.5 text-slate-400 hover:text-red-400"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
          <label htmlFor={`sel-expr-${rule.id}`} className="sr-only">Stream expression</label>
          <input
            id={`sel-expr-${rule.id}`}
            type="text"
            value={rule.expression}
            placeholder={`Expression — e.g. stream.resolution == '4k' && stream.visualTag contains 'HDR'`}
            onChange={(e) => onUpdate({ expression: e.target.value })}
            disabled={disabled}
            className="w-full px-2 py-1 text-xs font-mono bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
          />
        </div>
      </div>
    </div>
  );
});

// ─── Import dialog ───────────────────────────────────────────────────

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (rules: RulesBlock, mode: 'merge' | 'replace') => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

interface TemplateInput {
  id: string;
  name: string;
  description?: string;
  type: 'select' | 'boolean' | 'alert' | 'socials';
  required?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
}

interface TemplatePreview {
  name: string;
  description?: string;
  inputs: TemplateInput[];
}

type DialogPhase = 'input' | 'variant' | 'result';

function ImportDialog({ open, onClose, onImport, apiFetch }: ImportDialogProps) {
  const [jsonText, setJsonText] = useState('');
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<DialogPhase>('input');
  const [template, setTemplate] = useState<TemplatePreview | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ kind: string; name: string; message: string }[]>([]);
  const [parsed, setParsed] = useState<RulesBlock | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setJsonText(''); setUrl(''); setPhase('input'); setTemplate(null); setInputValues({});
      setError(null); setWarnings([]); setParsed(null); setLoading(false);
    }
  }, [open]);

  const callImport = async (body: Record<string, unknown>) => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch('/api/rules/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Import failed (${res.status})`);
        return;
      }
      if (data.template) {
        // Phase 1 response — template detected, user picks variant
        setTemplate(data.template);
        setInputValues(data.defaults ?? {});
        setPhase('variant');
        setWarnings([]);
        setParsed(null);
      } else {
        // Flat JSON / URL path — rules returned directly
        setParsed(data.rules);
        setWarnings(data.warnings || []);
        setPhase('result');
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const onParseInput = () => {
    if (url) {
      callImport({ url });
    } else if (jsonText) {
      callImport({ json: jsonText, preview: true });
    }
  };

  const onResolveVariant = () => {
    // Re-submit using whichever source the user originally supplied. When the
    // template was fetched from a URL, `jsonText` is empty; the server needs
    // the URL again to re-fetch before resolving the DSL with our inputs.
    if (url) {
      callImport({ url, inputs: inputValues });
    } else {
      callImport({ json: jsonText, inputs: inputValues });
    }
  };

  if (!open) return null;

  const totalParsed = (parsed?.rankedRegexPatterns?.length ?? 0) + (parsed?.rankedStreamExpressions?.length ?? 0);

  const dialog = (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700/50 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-slate-700/30">
          <h3 className="text-sm font-medium text-slate-200">
            {phase === 'variant' ? 'Template Options' : 'Import Ranked Rules'}
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {phase === 'input' && (
          <div className="p-4 space-y-3 overflow-y-auto">
            <p className="text-xs text-slate-500">
              Fetch from a URL, or paste ranked-rules JSON below. Flat (<code className="text-slate-400">rankedRegexPatterns</code> at root)
              and community ranked-rules template shapes are both accepted. Templates with variant inputs that gate which rules load, e.g. preferred languages, filtering engine, or release-tier toggles, prompt you to pick before following their synced URLs.
            </p>
            <div className="space-y-1.5">
              <label htmlFor="import-url" className="text-xs text-slate-400">Fetch from URL</label>
              <input
                id="import-url"
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); if (e.target.value) setJsonText(''); }}
                placeholder="https://raw.githubusercontent.com/.../regexes.json"
                className="w-full px-2 py-1.5 text-xs font-mono bg-slate-800/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              />
              <button
                type="button"
                onClick={() => {
                  setUrl(PINNED_TAMTARO_URL);
                  setJsonText('');
                  setError(null);
                  setTemplate(null);
                  setInputValues({});
                  setParsed(null);
                  setWarnings([]);
                }}
                aria-label="Pre-fill URL with Tamtaro 2.5.2 preset"
                className="text-xs text-purple-400 hover:text-purple-300 focus:outline-none focus:ring-1 focus:ring-purple-500/50 rounded"
              >
                Use Tamtaro 2.5.2 preset
              </button>
            </div>
            <div className="text-[11px] text-slate-500 text-center">— or —</div>
            <div className="space-y-1.5">
              <label htmlFor="import-json" className="text-xs text-slate-400">Paste JSON</label>
              <textarea
                id="import-json"
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value); if (e.target.value) setUrl(''); }}
                placeholder='{"rankedRegexPatterns":[...],"rankedStreamExpressions":[...]}  or a community ranked-rules template'
                rows={10}
                className="w-full px-2 py-1.5 text-xs font-mono bg-slate-800/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              />
            </div>
            {error && (
              <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div>{error}</div>
              </div>
            )}
          </div>
        )}

        {phase === 'variant' && template && (() => {
          // Community templates include many inputs that configure addon-
          // native behavior (addon lists, formatters, TorBox tiers, catalogs) which
          // we don't consume. Hide everything except actionable select/boolean
          // inputs that can actually change which synced URLs we follow.
          const actionableInputs = template.inputs.filter(inp => inp.type === 'select' || inp.type === 'boolean');
          return (
          <div className="p-4 space-y-3 overflow-y-auto">
            <div>
              <div className="text-sm font-medium text-slate-200">{template.name}</div>
              <div className="text-xs text-slate-400 mt-1">
                Only the options that change which rules get loaded are shown. Other template options (formatter, addon list, TorBox tier, etc.) are addon-specific and don't apply here.
              </div>
            </div>
            <div className="space-y-3 pt-2 border-t border-slate-700/30">
              {actionableInputs.length === 0 && (
                <div className="text-xs text-slate-500 italic">No variant choices required — click Fetch &amp; Parse below to load the rules.</div>
              )}
              {actionableInputs.map((input) => {
                if (input.type === 'socials') return null;
                if (input.type === 'select') {
                  return (
                    <div key={input.id} className="space-y-1">
                      <label htmlFor={`tpl-${input.id}`} className="text-xs font-medium text-slate-300">{input.name}</label>
                      {input.description && <div className="text-[11px] text-slate-500">{input.description}</div>}
                      <select
                        id={`tpl-${input.id}`}
                        value={String(inputValues[input.id] ?? input.default ?? '')}
                        onChange={(e) => setInputValues((v) => ({ ...v, [input.id]: e.target.value }))}
                        className="w-full px-2 py-1.5 text-xs bg-slate-800/70 border border-slate-700/50 rounded text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                      >
                        {(input.options ?? []).map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  );
                }
                if (input.type === 'boolean') {
                  const val = Boolean(inputValues[input.id] ?? input.default ?? false);
                  return (
                    <div key={input.id} className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <label htmlFor={`tpl-${input.id}`} className="text-xs font-medium text-slate-300 cursor-pointer">{input.name}</label>
                        {input.description && <div className="text-[11px] text-slate-500">{input.description}</div>}
                      </div>
                      <button
                        type="button"
                        id={`tpl-${input.id}`}
                        aria-pressed={val}
                        onClick={() => setInputValues((v) => ({ ...v, [input.id]: !val }))}
                        className={clsx(
                          "relative w-10 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5",
                          val ? "bg-purple-500" : "bg-slate-600"
                        )}
                      >
                        <div className={clsx(
                          "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                          val ? "left-5" : "left-1"
                        )} />
                      </button>
                    </div>
                  );
                }
                return null;
              })}
            </div>
            {error && (
              <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div>{error}</div>
              </div>
            )}
          </div>
          );
        })()}

        {phase === 'result' && parsed && (
          <div className="p-4 space-y-3 overflow-y-auto">
            <div className="text-xs text-slate-300">
              Parsed <span className="font-medium text-emerald-400">{parsed.rankedRegexPatterns?.length ?? 0}</span> regex rule(s)
              and <span className="font-medium text-emerald-400">{parsed.rankedStreamExpressions?.length ?? 0}</span> SEL rule(s).
            </div>
            {warnings.length > 0 && (
              <details className="bg-slate-800/50 rounded border border-slate-700/50 px-2 py-1">
                <summary className="text-xs text-amber-400 cursor-pointer">{warnings.length} warning(s) — rules skipped</summary>
                <ul className="mt-1.5 space-y-0.5 text-xs">
                  {warnings.map((w, i) => (
                    <li key={i} className="text-slate-500"><span className="text-amber-400/70">[{w.kind}]</span> {w.name}: {w.message}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="flex items-center justify-between p-4 border-t border-slate-700/30 gap-2">
          {phase === 'input' && (
            <>
              <span />
              <button onClick={onParseInput} disabled={(!jsonText && !url) || loading} className="btn-primary text-xs">
                {loading ? 'Parsing…' : url ? 'Fetch' : 'Parse'}
              </button>
            </>
          )}
          {phase === 'variant' && (
            <>
              <button onClick={() => { setPhase('input'); setError(null); }} disabled={loading} className="btn-secondary text-xs flex items-center gap-1">
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>
              <button onClick={onResolveVariant} disabled={loading} className="btn-primary text-xs">
                {loading ? 'Fetching…' : 'Fetch & Parse'}
              </button>
            </>
          )}
          {phase === 'result' && (
            <>
              <button onClick={() => setPhase('input')} className="btn-secondary text-xs flex items-center gap-1">
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => parsed && onImport(parsed, 'merge')}
                  disabled={!parsed || totalParsed === 0}
                  className="btn-secondary text-xs"
                  title="Add these rules to your existing list"
                >
                  Merge
                </button>
                <button
                  onClick={() => parsed && onImport(parsed, 'replace')}
                  disabled={!parsed || totalParsed === 0}
                  className="btn-primary text-xs"
                  title="Replace your current rules with these"
                >
                  Replace
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  // Portal to document.body so parent overlay transforms don't trap fixed positioning.
  // Matches the pattern used in ProviderManager.tsx:489 and StreamDisplayOverlay.tsx:471.
  return createPortal(dialog, document.body);
}

// ─── Live test field ─────────────────────────────────────────────────

interface LiveTestFieldProps {
  rules: RulesBlock | undefined;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

interface PreviewResponse {
  regexScore: number;
  seScore: number;
  totalScore: number;
  excluded: boolean;
  matched: { ruleId: string; ruleName: string; kind: 'regex' | 'sel'; score: number; mode?: 'score' | 'keep' | 'drop' }[];
  compileErrors: { ruleId: string; ruleName: string; kind: 'regex' | 'sel'; message: string }[];
  evalErrors: { ruleId: string; ruleName: string; kind: 'regex' | 'sel'; message: string }[];
}

function LiveTestField({ rules, apiFetch }: LiveTestFieldProps) {
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();
    if (!sample || !rules) { setPreview(null); setError(null); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    timerRef.current = window.setTimeout(async () => {
      try {
        const res = await apiFetch('/api/rules/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sample, rules }),
          signal: ctrl.signal,
        });
        const data = await res.json();
        if (!res.ok) { setError(data.error || `Preview failed (${res.status})`); setPreview(null); }
        else { setPreview(data); setError(null); }
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message ?? String(e));
      }
    }, 150);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); ctrl.abort(); };
  }, [sample, rules, apiFetch]);

  return (
    <div className="p-3 rounded-lg border border-slate-700/50 bg-slate-800/40 space-y-2">
      <div className="flex items-center gap-2">
        <FlaskConical className="w-4 h-4 text-purple-400" />
        <label htmlFor="rules-live-test" className="text-sm font-medium text-slate-300">Live Test</label>
      </div>
      <input
        id="rules-live-test"
        type="text"
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        placeholder="Paste a release title to see which rules match and the total score…"
        className="w-full px-2 py-1.5 text-xs font-mono bg-slate-900/70 border border-slate-700/50 rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
      />
      <p className="text-[11px] text-slate-500 italic">Only title-derived scoring is testable. Rules that filter on size, age, or bitrate need a real search to evaluate. Those attributes can't be inferred from the title alone.</p>
      {error && (
        <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-300">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}
      {preview && (
        <div className="text-xs space-y-1.5">
          <div className="flex flex-wrap gap-3 text-slate-400">
            <div>regex score: <span className={clsx("font-medium", preview.regexScore > 0 ? "text-emerald-400" : preview.regexScore < 0 ? "text-red-400" : "text-slate-300")}>{preview.regexScore}</span></div>
            <div>SEL score: <span className={clsx("font-medium", preview.seScore > 0 ? "text-emerald-400" : preview.seScore < 0 ? "text-red-400" : "text-slate-300")}>{preview.seScore}</span></div>
            <div>total: <span className={clsx("font-semibold", preview.excluded ? "text-red-400" : preview.totalScore > 0 ? "text-emerald-400" : preview.totalScore < 0 ? "text-red-400" : "text-slate-300")}>{preview.excluded ? 'EXCLUDED' : preview.totalScore}</span></div>
          </div>
          {preview.matched.length > 0 && (
            <ul className="space-y-0.5">
              {preview.matched.map((m, i) => {
                let label: string;
                let labelClass: string;
                if (m.mode === 'drop') {
                  label = 'drops';
                  labelClass = 'text-red-400';
                } else if (m.mode === 'keep') {
                  label = 'keeps';
                  labelClass = 'text-emerald-400';
                } else {
                  label = (m.score > 0 ? '+' : '') + m.score;
                  labelClass = m.score > 0 ? 'text-emerald-400' : m.score < 0 ? 'text-red-400' : 'text-slate-400';
                }
                return (
                  <li key={i} className="text-slate-500">
                    <span className="text-slate-400">[{m.kind}]</span> {m.ruleName} <span className={clsx("font-medium", labelClass)}>({label})</span>
                  </li>
                );
              })}
            </ul>
          )}
          {(preview.compileErrors.length > 0 || preview.evalErrors.length > 0) && (
            <div className="text-amber-400/80">
              {preview.compileErrors.length > 0 && <div>{preview.compileErrors.length} rule(s) failed to compile:</div>}
              <ul className="mt-0.5 space-y-0.5">
                {[...preview.compileErrors, ...preview.evalErrors].map((e, i) => (
                  <li key={i} className="text-slate-500">• {e.ruleName}: {e.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Top-level section ───────────────────────────────────────────────

export default function RulesSection({ rules, onChange, apiFetch, disabled }: RulesSectionProps) {
  const [importOpen, setImportOpen] = useState(false);

  const regex = rules?.rankedRegexPatterns ?? [];
  const sel   = rules?.rankedStreamExpressions ?? [];

  const [regexExpanded, setRegexExpanded] = useState(regex.length <= 20);
  const [selExpanded, setSelExpanded]     = useState(sel.length   <= 20);

  // Per-list selection sets for batch operations. Ephemeral — cleared on
  // batch delete success and on import (rule ids may have changed).
  const [selectedRegex, setSelectedRegex] = useState<Set<string>>(() => new Set());
  const [selectedSel, setSelectedSel]     = useState<Set<string>>(() => new Set());

  // DnD pointer state. `null` = no drag in flight.
  const [draggedRegexId, setDraggedRegexId] = useState<string | null>(null);
  const [dragOverRegexId, setDragOverRegexId] = useState<string | null>(null);
  const [draggedSelId, setDraggedSelId] = useState<string | null>(null);
  const [dragOverSelId, setDragOverSelId] = useState<string | null>(null);

  // Batch-delete confirmation modal target. `null` = closed.
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'regex' | 'sel'; count: number } | null>(null);

  // Refs for memo-friendly callbacks (handlers keep stable identity across renders).
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const update = useCallback((next: Partial<RulesBlock>) => {
    onChangeRef.current({ ...(rulesRef.current ?? {}), ...next });
  }, []);

  const updateRegex = useCallback((arr: RankedRegexRule[]) => update({ rankedRegexPatterns: arr }), [update]);
  const updateSel   = useCallback((arr: RankedSelRule[]) => update({ rankedStreamExpressions: arr }), [update]);

  const onAddRegex = useCallback(() => {
    const cur = rulesRef.current?.rankedRegexPatterns ?? [];
    updateRegex([...cur, { id: newId(), name: '', pattern: '', flags: 'i', score: 10, enabled: true, mode: 'score' }]);
  }, [updateRegex]);
  const onAddSel = useCallback(() => {
    const cur = rulesRef.current?.rankedStreamExpressions ?? [];
    updateSel([...cur, { id: newId(), name: '', expression: '', score: 10, enabled: true }]);
  }, [updateSel]);

  const onImport = useCallback((imported: RulesBlock, mode: 'merge' | 'replace') => {
    const curRegex = rulesRef.current?.rankedRegexPatterns ?? [];
    const curSel = rulesRef.current?.rankedStreamExpressions ?? [];
    if (mode === 'replace') {
      update({
        rankedRegexPatterns: imported.rankedRegexPatterns ?? [],
        rankedStreamExpressions: imported.rankedStreamExpressions ?? [],
      });
    } else {
      update({
        rankedRegexPatterns: [...curRegex, ...(imported.rankedRegexPatterns ?? [])],
        rankedStreamExpressions: [...curSel, ...(imported.rankedStreamExpressions ?? [])],
      });
    }
    setSelectedRegex(new Set());
    setSelectedSel(new Set());
    setImportOpen(false);
  }, [update]);

  // ── Regex row handlers (stable identity) ──────────────────────────────
  const regexHandlers = useCallback((idx: number, ruleId: string) => ({
    onUpdate: (patch: Partial<RankedRegexRule>) => {
      const cur = rulesRef.current?.rankedRegexPatterns ?? [];
      const copy = cur.slice();
      if (copy[idx]) copy[idx] = { ...copy[idx], ...patch };
      updateRegex(copy);
    },
    onDelete: () => {
      const cur = rulesRef.current?.rankedRegexPatterns ?? [];
      updateRegex(cur.filter(r => r.id !== ruleId));
      setSelectedRegex(prev => { if (!prev.has(ruleId)) return prev; const next = new Set(prev); next.delete(ruleId); return next; });
    },
    onMoveUp: () => {
      const cur = rulesRef.current?.rankedRegexPatterns ?? [];
      const i = cur.findIndex(r => r.id === ruleId);
      if (i <= 0) return;
      const copy = cur.slice();
      [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]];
      updateRegex(copy);
    },
    onMoveDown: () => {
      const cur = rulesRef.current?.rankedRegexPatterns ?? [];
      const i = cur.findIndex(r => r.id === ruleId);
      if (i < 0 || i >= cur.length - 1) return;
      const copy = cur.slice();
      [copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
      updateRegex(copy);
    },
    onToggleSelect: () => {
      setSelectedRegex(prev => {
        const next = new Set(prev);
        if (next.has(ruleId)) next.delete(ruleId); else next.add(ruleId);
        return next;
      });
    },
    onDragStart: () => setDraggedRegexId(ruleId),
    onDragOver: () => setDragOverRegexId(ruleId),
    onDrop: () => {
      const cur = rulesRef.current?.rankedRegexPatterns ?? [];
      if (!draggedRegexId || draggedRegexId === ruleId) return;
      const from = cur.findIndex(r => r.id === draggedRegexId);
      const to = cur.findIndex(r => r.id === ruleId);
      if (from < 0 || to < 0) return;
      const copy = cur.slice();
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      updateRegex(copy);
      setDraggedRegexId(null);
      setDragOverRegexId(null);
    },
    onDragEnd: () => { setDraggedRegexId(null); setDragOverRegexId(null); },
  }), [updateRegex, draggedRegexId]);

  // ── SEL row handlers (stable identity) ────────────────────────────────
  const selHandlers = useCallback((idx: number, ruleId: string) => ({
    onUpdate: (patch: Partial<RankedSelRule>) => {
      const cur = rulesRef.current?.rankedStreamExpressions ?? [];
      const copy = cur.slice();
      if (copy[idx]) copy[idx] = { ...copy[idx], ...patch };
      updateSel(copy);
    },
    onDelete: () => {
      const cur = rulesRef.current?.rankedStreamExpressions ?? [];
      updateSel(cur.filter(r => r.id !== ruleId));
      setSelectedSel(prev => { if (!prev.has(ruleId)) return prev; const next = new Set(prev); next.delete(ruleId); return next; });
    },
    onMoveUp: () => {
      const cur = rulesRef.current?.rankedStreamExpressions ?? [];
      const i = cur.findIndex(r => r.id === ruleId);
      if (i <= 0) return;
      const copy = cur.slice();
      [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]];
      updateSel(copy);
    },
    onMoveDown: () => {
      const cur = rulesRef.current?.rankedStreamExpressions ?? [];
      const i = cur.findIndex(r => r.id === ruleId);
      if (i < 0 || i >= cur.length - 1) return;
      const copy = cur.slice();
      [copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
      updateSel(copy);
    },
    onToggleSelect: () => {
      setSelectedSel(prev => {
        const next = new Set(prev);
        if (next.has(ruleId)) next.delete(ruleId); else next.add(ruleId);
        return next;
      });
    },
    onDragStart: () => setDraggedSelId(ruleId),
    onDragOver: () => setDragOverSelId(ruleId),
    onDrop: () => {
      const cur = rulesRef.current?.rankedStreamExpressions ?? [];
      if (!draggedSelId || draggedSelId === ruleId) return;
      const from = cur.findIndex(r => r.id === draggedSelId);
      const to = cur.findIndex(r => r.id === ruleId);
      if (from < 0 || to < 0) return;
      const copy = cur.slice();
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      updateSel(copy);
      setDraggedSelId(null);
      setDragOverSelId(null);
    },
    onDragEnd: () => { setDraggedSelId(null); setDragOverSelId(null); },
  }), [updateSel, draggedSelId]);

  // ── Bulk operations ───────────────────────────────────────────────────
  const onSelectAllRegex = useCallback(() => setSelectedRegex(new Set((rulesRef.current?.rankedRegexPatterns ?? []).map(r => r.id))), []);
  const onDeselectAllRegex = useCallback(() => setSelectedRegex(new Set()), []);
  const onSelectAllSel = useCallback(() => setSelectedSel(new Set((rulesRef.current?.rankedStreamExpressions ?? []).map(r => r.id))), []);
  const onDeselectAllSel = useCallback(() => setSelectedSel(new Set()), []);

  const onBatchDeleteRegex = useCallback(() => {
    const cur = rulesRef.current?.rankedRegexPatterns ?? [];
    updateRegex(cur.filter(r => !selectedRegex.has(r.id)));
    setSelectedRegex(new Set());
    setConfirmDelete(null);
  }, [updateRegex, selectedRegex]);
  const onBatchDeleteSel = useCallback(() => {
    const cur = rulesRef.current?.rankedStreamExpressions ?? [];
    updateSel(cur.filter(r => !selectedSel.has(r.id)));
    setSelectedSel(new Set());
    setConfirmDelete(null);
  }, [updateSel, selectedSel]);

  // ESC closes the confirmation modal
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirmDelete(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDelete]);

  return (
    <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-300 flex flex-wrap items-center gap-2">
            Ranked Rules
            {(regex.length > 0 || sel.length > 0) && (
              <span className="text-xs font-normal text-slate-500">({regex.length} regex, {sel.length} SEL)</span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            Score releases with regex patterns and Stream Expression Language (SEL). <span className="text-emerald-400">Positive</span> boosts, <span className="text-red-400">negative</span> penalizes. Score <span className="text-slate-400">0</span> contributes nothing to ranking, useful for tagging or for SEL templates that compute the math. Set Mode to <span className="text-emerald-400">Keep</span> or <span className="text-red-400">Drop</span> to filter results in/out instead. Enable the <span className="font-medium text-slate-400">regexScore</span> or <span className="font-medium text-slate-400">seScore</span> sort methods below to use these for ranking.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          disabled={disabled}
          className="btn-secondary text-xs flex items-center gap-1 shrink-0"
        >
          <Upload className="w-3.5 h-3.5" />
          Import
        </button>
      </div>

      {/* Regex rules */}
      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setRegexExpanded(v => !v)}
            aria-expanded={regexExpanded}
            aria-controls="rules-regex-body"
            className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 group"
          >
            <ChevronDown className={clsx(
              "w-3.5 h-3.5 text-slate-500 transition-transform group-hover:text-slate-300",
              regexExpanded ? "" : "-rotate-90"
            )} />
            Regex Rules <span className="text-slate-500 font-normal">({regex.length})</span>
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSelectAllRegex}
              disabled={disabled || regex.length === 0 || selectedRegex.size === regex.length}
              className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={onDeselectAllRegex}
              disabled={disabled || selectedRegex.size === 0}
              className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Deselect All
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete({ kind: 'regex', count: selectedRegex.size })}
              disabled={disabled || selectedRegex.size === 0}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete Selected ({selectedRegex.size})
            </button>
            <button
              type="button"
              onClick={onAddRegex}
              disabled={disabled}
              aria-label="Add regex rule"
              className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
        </div>
        {regexExpanded && (<div id="rules-regex-body" className="space-y-2">
          {regex.length === 0 ? (
            <div className="text-xs text-slate-500 italic px-2 py-3">No regex rules yet. Add one above, or import from JSON.</div>
          ) : (
            regex.map((rule, idx) => {
              const h = regexHandlers(idx, rule.id);
              return (
                <RegexRuleRow
                  key={rule.id}
                  rule={rule}
                  disabled={disabled}
                  canMoveUp={idx > 0}
                  canMoveDown={idx < regex.length - 1}
                  selected={selectedRegex.has(rule.id)}
                  isDragging={draggedRegexId === rule.id}
                  isDragOver={dragOverRegexId === rule.id && draggedRegexId !== rule.id}
                  {...h}
                />
              );
            })
          )}
        </div>)}
      </div>

      {/* SEL rules */}
      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSelExpanded(v => !v)}
            aria-expanded={selExpanded}
            aria-controls="rules-sel-body"
            className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 group"
          >
            <ChevronDown className={clsx(
              "w-3.5 h-3.5 text-slate-500 transition-transform group-hover:text-slate-300",
              selExpanded ? "" : "-rotate-90"
            )} />
            Stream Expression Rules <span className="text-slate-500 font-normal">({sel.length})</span>
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSelectAllSel}
              disabled={disabled || sel.length === 0 || selectedSel.size === sel.length}
              className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={onDeselectAllSel}
              disabled={disabled || selectedSel.size === 0}
              className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Deselect All
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete({ kind: 'sel', count: selectedSel.size })}
              disabled={disabled || selectedSel.size === 0}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete Selected ({selectedSel.size})
            </button>
            <button
              type="button"
              onClick={onAddSel}
              disabled={disabled}
              aria-label="Add SEL rule"
              className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
        </div>
        {selExpanded && (<div id="rules-sel-body" className="space-y-2">
          {sel.length === 0 ? (
            <div className="text-xs text-slate-500 italic px-2 py-3">No SEL rules yet. Attributes: resolution, codec, releaseGroup, visualTag, audioTag, videoTag, edition, language, size, title, filename, indexer, age, seeders.</div>
          ) : (
            sel.map((rule, idx) => {
              const h = selHandlers(idx, rule.id);
              return (
                <SelRuleRow
                  key={rule.id}
                  rule={rule}
                  disabled={disabled}
                  canMoveUp={idx > 0}
                  canMoveDown={idx < sel.length - 1}
                  selected={selectedSel.has(rule.id)}
                  isDragging={draggedSelId === rule.id}
                  isDragOver={dragOverSelId === rule.id && draggedSelId !== rule.id}
                  {...h}
                />
              );
            })
          )}
        </div>)}
      </div>

      {/* Live test field — stays accessible regardless of section state. */}
      {(regex.length > 0 || sel.length > 0) && <LiveTestField rules={rules} apiFetch={apiFetch} />}

      {confirmDelete && (
        <ConfirmDeleteModal
          count={confirmDelete.count}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={confirmDelete.kind === 'regex' ? onBatchDeleteRegex : onBatchDeleteSel}
        />
      )}

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={onImport}
        apiFetch={apiFetch}
      />
    </div>
  );
}

// ─── Inline batch-delete confirmation modal ──────────────────────────

interface ConfirmDeleteModalProps {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDeleteModal({ count, onCancel, onConfirm }: ConfirmDeleteModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-slate-900 border border-slate-700/50 rounded-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-slate-700/30">
          <h3 className="text-sm font-medium text-slate-200">Delete {count} rule{count === 1 ? '' : 's'}?</h3>
        </div>
        <div className="p-4 text-xs text-slate-400">This cannot be undone.</div>
        <div className="px-4 pb-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 hover:text-slate-100 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

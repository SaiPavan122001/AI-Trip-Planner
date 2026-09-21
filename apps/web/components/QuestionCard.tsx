'use client';

import { useEffect, useState } from 'react';
import type { Question } from '@/lib/api';

/**
 * Renders whatever question the engine hands back. The component knows how to
 * draw each answer type and nothing about which question comes next — that
 * decision lives in the engine, so the interview can change without the UI
 * needing to learn the new order.
 */

export function QuestionCard({
  question,
  progress,
  busy,
  onAnswer,
  onSkip,
}: {
  question: Question;
  progress: number;
  busy: boolean;
  onAnswer: (value: unknown) => void;
  onSkip: () => void;
}) {
  const [showReason, setShowReason] = useState(false);

  return (
    <section className="card p-5 sm:p-7" aria-live="polite">
      <div className="mb-5">
        <div className="h-1 w-full overflow-hidden rounded-full bg-sand-200">
          <div
            className="h-full rounded-full bg-teal-500 transition-[width] duration-500"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs uppercase tracking-wide text-ink-faint">
          {STAGE_LABEL[question.stage] ?? question.stage}
        </p>
      </div>

      <h2 className="font-display text-2xl leading-snug tracking-tight">{question.prompt}</h2>
      {question.helpText ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{question.helpText}</p>
      ) : null}

      <div className="mt-6">
        <AnswerControl key={question.key} question={question} busy={busy} onAnswer={onAnswer} />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-sand-200 pt-4">
        <button
          type="button"
          className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
          onClick={() => setShowReason((v) => !v)}
          aria-expanded={showReason}
        >
          {showReason ? 'Hide' : 'Why is this being asked?'}
        </button>
        {question.required ? (
          <span className="text-xs text-ink-faint">Needed before a plan can be built</span>
        ) : (
          <button type="button" className="btn-ghost" onClick={onSkip} disabled={busy}>
            Skip this
          </button>
        )}
      </div>
      {showReason ? (
        <p className="mt-3 rounded-xl bg-sand-100 px-4 py-3 text-sm text-ink-soft">
          {question.reason}
        </p>
      ) : null}
    </section>
  );
}

const STAGE_LABEL: Record<string, string> = {
  budget: 'Budget',
  style: 'Travel style',
  priorities: 'What matters most',
  accommodation: 'Where you stay',
  traveler_needs: 'Who is travelling',
  transport: 'Getting there',
};

function AnswerControl({
  question,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (value: unknown) => void;
}) {
  switch (question.kind) {
    case 'single_choice':
      return <SingleChoice question={question} busy={busy} onAnswer={onAnswer} />;
    case 'multi_choice':
      return <MultiChoice question={question} busy={busy} onAnswer={onAnswer} />;
    case 'ranking':
      return <Ranking question={question} busy={busy} onAnswer={onAnswer} />;
    case 'money':
      return <MoneyInput question={question} busy={busy} onAnswer={onAnswer} />;
    case 'number':
      return <NumberInput question={question} busy={busy} onAnswer={onAnswer} />;
    case 'boolean':
      return <BooleanChoice busy={busy} onAnswer={onAnswer} />;
    default:
      return <TextInput busy={busy} onAnswer={onAnswer} />;
  }
}

function SingleChoice({
  question,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (v: unknown) => void;
}) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {question.options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={busy}
          onClick={() => onAnswer(option.value)}
          className="group rounded-xl border border-sand-300 bg-white p-4 text-left transition hover:border-teal-500 hover:shadow-card disabled:opacity-50"
        >
          <span className="block text-sm font-semibold">{option.label}</span>
          {option.description ? (
            <span className="mt-1 block text-xs leading-relaxed text-ink-soft">
              {option.description}
            </span>
          ) : null}
          {option.implication ? (
            <span className="mt-2 block text-[11px] text-ink-faint">{option.implication}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function MultiChoice({
  question,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (v: unknown) => void;
}) {
  const [selected, setSelected] = useState<string[]>(
    // Multi-select questions about what to search start fully selected:
    // ruling things out should be a deliberate act, not a default.
    question.key === 'transport.mode_openness' ? question.options.map((o) => o.value) : [],
  );

  const toggle = (value: string) =>
    setSelected((current) =>
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    );

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {question.options.map((option) => {
          const active = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              aria-pressed={active}
              className={`rounded-full border px-4 py-2 text-sm transition ${
                active
                  ? 'border-teal-500 bg-teal-500 text-white'
                  : 'border-sand-300 bg-white text-ink-soft hover:border-ink-faint'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="btn-primary mt-5"
        disabled={busy}
        onClick={() => onAnswer(selected)}
      >
        Continue
      </button>
    </div>
  );
}

/**
 * Ranking is an ordered click: the first thing you pick is the first thing the
 * planner optimises for. Showing the position back as you go is what makes
 * "put the most important first" mean something concrete.
 */
function Ranking({
  question,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (v: unknown) => void;
}) {
  const [order, setOrder] = useState<string[]>([]);

  const toggle = (value: string) =>
    setOrder((current) =>
      current.includes(value)
        ? current.filter((v) => v !== value)
        : current.length >= 4
          ? current
          : [...current, value],
    );

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {question.options.map((option) => {
          const position = order.indexOf(option.value);
          const active = position >= 0;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              aria-pressed={active}
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition ${
                active
                  ? 'border-teal-500 bg-teal-500 text-white'
                  : 'border-sand-300 bg-white text-ink-soft hover:border-ink-faint'
              }`}
            >
              {active ? (
                <span className="grid h-5 w-5 place-items-center rounded-full bg-white/25 text-[11px] font-semibold tabular-nums">
                  {position + 1}
                </span>
              ) : null}
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        {order.length === 0
          ? 'Pick up to four, most important first.'
          : `Optimising for ${order.join(' → ')}.`}
      </p>
      <button
        type="button"
        className="btn-primary mt-4"
        disabled={busy || order.length === 0}
        onClick={() => onAnswer(order)}
      >
        Continue
      </button>
    </div>
  );
}

function MoneyInput({
  question,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (v: unknown) => void;
}) {
  const [value, setValue] = useState('');
  const currency = question.currency ?? 'INR';
  const exponent = ['JPY', 'KRW', 'VND'].includes(currency) ? 0 : 2;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const major = Number(value);
        if (!Number.isFinite(major) || major <= 0) return;
        // Money crosses the wire in minor units: the whole system refuses to
        // do arithmetic on floating-point currency.
        onAnswer({ amount: Math.round(major * 10 ** exponent), currency });
      }}
      className="flex flex-wrap items-center gap-3"
    >
      <div className="flex items-center rounded-xl border border-sand-300 bg-white">
        <span className="px-3 text-sm text-ink-faint">{currency}</span>
        <input
          className="w-40 border-0 bg-transparent py-3 pr-4 text-sm tabular-nums focus:outline-none"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0"
          autoFocus
        />
      </div>
      <button type="submit" className="btn-primary" disabled={busy || value === ''}>
        Continue
      </button>
    </form>
  );
}

function NumberInput({
  question,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (v: unknown) => void;
}) {
  const [value, setValue] = useState(String(question.min ?? 0));
  useEffect(() => setValue(String(question.min ?? 0)), [question.min]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(Number(value));
      }}
      className="flex flex-wrap items-center gap-3"
    >
      <input
        type="number"
        className="field w-32 tabular-nums"
        min={question.min ?? 0}
        max={question.max ?? 20}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button type="submit" className="btn-primary" disabled={busy}>
        Continue
      </button>
    </form>
  );
}

function BooleanChoice({ busy, onAnswer }: { busy: boolean; onAnswer: (v: unknown) => void }) {
  return (
    <div className="flex gap-3">
      <button type="button" className="btn-primary" disabled={busy} onClick={() => onAnswer(true)}>
        Yes
      </button>
      <button type="button" className="btn-ghost" disabled={busy} onClick={() => onAnswer(false)}>
        No
      </button>
    </div>
  );
}

function TextInput({ busy, onAnswer }: { busy: boolean; onAnswer: (v: unknown) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(value.trim());
      }}
      className="flex flex-wrap items-center gap-3"
    >
      <input
        className="field sm:w-96"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button type="submit" className="btn-primary" disabled={busy}>
        Continue
      </button>
    </form>
  );
}

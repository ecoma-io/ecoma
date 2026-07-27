/**
 * Alloy Tailwind preset — the shared theme.
 * Consumed by Storybook now and by apps/desktop later, so tokens live in ONE
 * place, shared across every Ecoma product. Colors read from CSS variables
 * (see src/styles/tokens.css), which define a single default theme — no
 * runtime dark/light switch.
 *
 * @type {import('tailwindcss').Config}
 */
const hsl = (v) => `hsl(var(${v}) / <alpha-value>)`;

export default {
  theme: {
    extend: {
      // Wide / ultra-wide breakpoints. Tailwind's defaults (sm..2xl, ceiling
      // 1536px) stop short of the desktop reality these apps run on, so we
      // extend upward — `extend` MERGES, keeping sm..2xl intact. Width-only;
      // there is no breakpoint vocabulary for height. Snap a window's minWidth
      // floor to one of these names (see Design System › Principles §4), never
      // an arbitrary px.
      screens: {
        "3xl": "1920px", // FHD desktop, maximized single monitor
        "4xl": "2560px", // QHD / 1440p
        "5xl": "3440px", // 21:9 ultra-wide
      },
      colors: {
        border: { DEFAULT: hsl("--border"), strong: hsl("--border-strong") },
        input: hsl("--input"),
        ring: hsl("--ring"),
        background: hsl("--background"),
        foreground: hsl("--foreground"),
        // Workspace chrome (sidebar/rails) — the sunken layer of the
        // elevation rhythm: sunken < background < card.
        sunken: hsl("--sunken"),
        card: { DEFAULT: hsl("--card"), foreground: hsl("--card-foreground") },
        popover: { DEFAULT: hsl("--popover"), foreground: hsl("--popover-foreground") },
        // Force 1 · Human (thép) — default action color: a person drives the UI.
        primary: {
          DEFAULT: hsl("--primary"),
          foreground: hsl("--primary-foreground"),
          muted: hsl("--primary-muted"),
        },
        // Force 2 · Agent (đồng) — automated work running / produced.
        agent: {
          DEFAULT: hsl("--agent"),
          foreground: hsl("--agent-foreground"),
          muted: hsl("--agent-muted"),
        },
        secondary: { DEFAULT: hsl("--secondary"), foreground: hsl("--secondary-foreground") },
        muted: { DEFAULT: hsl("--muted"), foreground: hsl("--muted-foreground") },
        subtle: { DEFAULT: hsl("--subtle"), foreground: hsl("--subtle-foreground") },
        destructive: { DEFAULT: hsl("--destructive"), foreground: hsl("--destructive-foreground") },
        success: { DEFAULT: hsl("--success"), foreground: hsl("--success-foreground") },
        warning: { DEFAULT: hsl("--warning"), foreground: hsl("--warning-foreground") },
        info: { DEFAULT: hsl("--info"), foreground: hsl("--info-foreground") },
      },
      // "Phay CNC" scale — sm 4 / md 8 / lg 12 / xl 16. Nesting law: inner
      // radius = outer radius − padding (min 2px); pick the step that honors it.
      borderRadius: {
        sm: "calc(var(--radius) - 4px)",
        md: "var(--radius)",
        lg: "calc(var(--radius) + 4px)",
        xl: "calc(var(--radius) + 8px)",
      },
      // The seam — dual-force gradient, handoff points and brand moments only
      // (Design System › Signature). Pair with `animate-seam-flow` while the
      // collaboration is live.
      backgroundImage: {
        seam: "var(--seam)",
      },
      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-mono)",
      },
      // The named type scale (Design System › Typography) as consumable
      // utilities — text-display … text-micro — so views compose the scale
      // instead of hand-picking text-lg/tracking/weight per heading. Weight
      // and tracking ride along; override with font-*/tracking-* only for a
      // deliberate divergence.
      fontSize: {
        display: ["2.25rem", { lineHeight: "1.1", fontWeight: "600", letterSpacing: "-0.02em" }],
        heading: ["1.5rem", { lineHeight: "1.2", fontWeight: "600", letterSpacing: "-0.01em" }],
        title: ["1.125rem", { lineHeight: "1.3", fontWeight: "500" }],
        body: ["0.875rem", { lineHeight: "1.55", fontWeight: "400" }],
        small: ["0.75rem", { lineHeight: "1.5", fontWeight: "400" }],
        micro: ["0.6875rem", { lineHeight: "1.4", fontWeight: "400" }],
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        // Focus halo — added on top of the crisp --ring outline, never
        // replacing it (see tokens.css / Design System › Signature).
        halo: "var(--halo)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
        in: "var(--ease-in)",
        spring: "var(--ease-spring)",
      },
      transitionDuration: {
        instant: "80ms",
        fast: "140ms",
        DEFAULT: "200ms",
        slow: "320ms",
        slower: "480ms",
      },
      animation: {
        fade: "fade var(--dur) var(--ease-out) both",
        "fade-rise": "fade-rise var(--dur) var(--ease-out) both",
        "scale-in": "scale-in var(--dur-fast) var(--ease-spring) both",
        shimmer: "shimmer 1.6s linear infinite",
        // Agent at work — the copper conduction pulse (see global.css).
        conduct: "conduct 1.8s var(--ease-in-out) infinite",
        // A live seam: the steel↔copper boundary drifts while the
        // collaboration is running; static once the work settles.
        "seam-flow": "seam-flow 3.2s linear infinite",
        "progress-indeterminate": "progress-indeterminate 1.3s var(--ease-in-out) infinite",
        "toast-in": "toast-in var(--dur) var(--ease-spring) both",
      },
    },
  },
  plugins: [],
};

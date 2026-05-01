// Inline SVG icons. Two flavours mixed in one file so route code can
// import a single module:
//
//   - Brand glyphs (LinkedIn, XING): Simple-Icons-style monochrome paths,
//     `fill="currentColor"`. Filled rather than stroked so the small 16 px
//     sizes the app uses stay legible and read as actual brand marks.
//   - UI glyphs (Globe, ExternalLink): Lucide-style line icons,
//     `stroke="currentColor"`, no fill — matches the rest of the app's
//     existing inline SVGs (chat composer, bell, etc.).
//
// We don't pull `lucide-react` or `simple-icons-react` because:
//   - The handful of icons we need fits in one file.
//   - It keeps the renderer bundle lean (no runtime icon library).
//   - Tree-shaking these libraries through Electron's CSP-friendlier
//     fetch path is fiddly when they ship as ESM with sub-imports.
//
// All icons accept a `size` prop (default 16) and inherit color from
// their parent — pair with `aria-label` on the wrapping link/button.

import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "ref"> & {
  size?: number;
};

function withDefaults(p: IconProps): SVGProps<SVGSVGElement> {
  const { size = 16, ...rest } = p;
  return {
    width: size,
    height: size,
    "aria-hidden": rest["aria-label"] ? undefined : true,
    focusable: "false",
    ...rest,
  };
}

/** LinkedIn brand glyph (Simple Icons). Filled, square viewBox. */
export function LinkedInIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...withDefaults(props)}>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

/** XING brand glyph (Simple Icons). Filled. */
export function XingIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...withDefaults(props)}>
      <path d="M18.188 0c-.517 0-.741.325-.927.66 0 0-7.455 13.224-7.702 13.657.015.024 4.919 9.023 4.919 9.023.17.308.436.66.967.66h3.454c.211 0 .375-.078.463-.22.089-.151.089-.346-.009-.539l-4.879-8.916c-.004-.006-.004-.016 0-.022L22.139.756c.095-.193.097-.387.006-.535C22.056.078 21.894 0 21.683 0h-3.495zM3.648 4.74c-.211 0-.385.074-.473.226-.09.149-.078.339.02.531l2.34 4.05c.004.01.004.016 0 .021L1.86 16.051c-.099.188-.093.381 0 .529.085.142.239.234.45.234h3.453c.518 0 .766-.348.945-.667l3.74-6.609-2.378-4.155c-.172-.315-.434-.659-.962-.659H3.648z" />
    </svg>
  );
}

/** Lucide globe — used for non-branded URL fields (websiteUrl, etc.). */
export function GlobeIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...withDefaults(props)}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/** Lucide external-link — annotates clickable URL text with a tiny chip. */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...withDefaults(props)}
    >
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

/**
 * URL của artwork SVG primary horizontal logo.
 *
 * Import qua bundler (default export của module `.svg`) nên consumer nhận
 * đúng URL đã resolve (dev server path hoặc hashed URL ở build) — không hard
 * code path, không copy SVG vào component. File artwork là immutable: mọi
 * thay đổi artwork là thay đổi file nguồn, không phải code.
 */
import logoSvg from '../assets/ecoma-logo-horizontal.svg';

export const ECOMA_LOGO_HORIZONTAL_SVG_URL: string = logoSvg;

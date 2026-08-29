/**
 * The certificate design studio, dev-only — this route is the photo cert;
 * the other states are /certificate-plain, -multi, -hub, -404, -503 (the
 * switcher at the bottom of the page walks them). Engine and the logging
 * story live in src/lib/cert-studio.ts.
 */
import type { APIRoute } from 'astro';
import { renderStudio } from '../lib/cert-studio';

export const GET: APIRoute = () => renderStudio('cert');

/**
 * One studio route per certificate state — /certificate-plain, -multi, -hub, -404, -503 (the photo cert lives at /certificate itself). Static output
 * can't see query strings, so states are paths. See src/lib/cert-studio.ts.
 */
import type { APIRoute } from 'astro';
import { STATES, renderStudio } from '../lib/cert-studio';

export function getStaticPaths() {
  return Object.keys(STATES)
    .filter((s) => s !== 'cert')
    .map((state) => ({ params: { state } }));
}

export const GET: APIRoute = ({ params }) => renderStudio(params.state ?? 'cert');

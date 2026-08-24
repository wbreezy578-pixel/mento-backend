import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import { storeChatImage } from '../../../../lib/chatImageUpload';
import { validateImageBuffer } from '../../../../lib/imageValidator';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const form = await req.formData() as unknown as globalThis.FormData;
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Image file is required' }, { status: 400 });
  if (file.size > 8 * 1024 * 1024) return NextResponse.json({ error: 'Image is too large' }, { status: 413 });

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const validated = validateImageBuffer(bytes, file.type);
    const id = storeChatImage(bytes.toString('base64'), validated.mimeType);
    return NextResponse.json(
      { uri: `/api/chat/upload/${id}`, mimeType: validated.mimeType },
      { headers: buildCorsHeaders(req.headers.get('origin')) },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid image' }, { status: 400 });
  }
}

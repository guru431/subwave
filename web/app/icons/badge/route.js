import { ImageResponse } from 'next/og';
import { DiscMark } from '../../../lib/discMark';

// Значок push-уведомления (`badge` в public/sw.js) для строки состояния
// Android: белый знак станции на прозрачном фоне. Рисуется тем же DiscMark,
// что и иконки установки, — сменится знак, сменится и значок. Свой статический
// маршрут, а не вариант апстримного `icons/[size]`: тот размеры и maskable
// перечисляет сам, и чужая строка в нём — лишний конфликт при обновлении.
// 96 px — размер, который Android масштабирует в 24 dp строки состояния.

export const contentType = 'image/png';
export const dynamic = 'force-static';

const SIZE = 96;

export function GET() {
  return new ImageResponse(<DiscMark size={SIZE} mono />, { width: SIZE, height: SIZE });
}

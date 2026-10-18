import axios from 'axios';

const HIGGSFIELD_API = process.env.HIGGSFIELD_API_URL || 'https://api.higgsfield.ai';
const HIGGSFIELD_KEY = process.env.HIGGSFIELD_API_KEY || '';

/**
 * Generate gambar AI via Higgsfield API.
 * Jika API key belum dikonfigurasi, mengembalikan URL placeholder SVG/Unsplash
 * agar alur pipeline tetap bisa diuji secara end-to-end.
 */
export async function higgsfieldImage(args) {
  const {
    prompt,
    width = 1920,
    height = 1080,
    model = process.env.HIGGSFIELD_DEFAULT_MODEL || 'soul',
  } = args;

  if (!HIGGSFIELD_KEY || HIGGSFIELD_KEY === 'your_higgsfield_api_key_here') {
    const encodedPrompt = encodeURIComponent(prompt.slice(0, 60));
    return {
      status: 'completed',
      mode: 'demo_fallback',
      model,
      width,
      height,
      prompt,
      image_url: `https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=${width}&q=85&prompt=${encodedPrompt}`,
      note: 'HIGGSFIELD_API_KEY belum diisi, menggunakan URL gambar demo resolusi tinggi.',
    };
  }

  const res = await axios.post(
    `${HIGGSFIELD_API}/v1/images`,
    {
      prompt,
      width,
      height,
      model,
    },
    {
      headers: {
        Authorization: `Bearer ${HIGGSFIELD_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  return res.data;
}

/**
 * Generate video AI via Higgsfield API (text-to-video / image-to-video).
 */
export async function higgsfieldVideo(args) {
  const {
    prompt,
    source_image = null,
    duration = 5,
    aspect_ratio = '16:9',
  } = args;

  if (!HIGGSFIELD_KEY || HIGGSFIELD_KEY === 'your_higgsfield_api_key_here') {
    return {
      status: 'completed',
      mode: 'demo_fallback',
      prompt,
      source_image,
      duration,
      aspect_ratio,
      video_url: 'https://assets.mixkit.co/videos/preview/mixkit-futuristic-city-traffic-at-night-34565-large.mp4',
      note: 'HIGGSFIELD_API_KEY belum diisi, menggunakan URL video demo.',
    };
  }

  const res = await axios.post(
    `${HIGGSFIELD_API}/v1/videos`,
    {
      prompt,
      image_url: source_image,
      duration,
      aspect_ratio,
    },
    {
      headers: {
        Authorization: `Bearer ${HIGGSFIELD_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    }
  );

  return res.data;
}

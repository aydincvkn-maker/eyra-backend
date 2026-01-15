// src/utils/cdn.js
// CDN URL Helper - Thumbnail ve medya dosyaları için

/**
 * CDN Configuration
 * Environment variables:
 * - CDN_BASE_URL: CDN base URL (örn: https://cdn.eyra.app)
 * - CDN_ENABLED: CDN aktif mi? (true/false)
 */

const CDN_BASE_URL = process.env.CDN_BASE_URL || '';
const CDN_ENABLED = process.env.CDN_ENABLED === 'true';

/**
 * Normal URL'i CDN URL'ine çevir
 * @param {string} url - Orijinal URL
 * @param {string} type - Dosya tipi ('thumbnail', 'gift', 'profile', 'media')
 * @returns {string} CDN URL veya orijinal URL
 */
const toCdnUrl = (url, type = 'media') => {
  if (!url || !CDN_ENABLED || !CDN_BASE_URL) {
    return url || '';
  }

  // Zaten CDN URL ise değiştirme
  if (url.startsWith(CDN_BASE_URL)) {
    return url;
  }

  // External URL'leri olduğu gibi bırak (örn: Google profil resimleri)
  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Kendi backend'imizden mi?
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
    if (!url.startsWith(backendUrl)) {
      return url; // External URL, CDN'e çevirme
    }
    // Backend URL'ini CDN URL'i ile değiştir
    return url.replace(backendUrl, CDN_BASE_URL);
  }

  // Relative path ise CDN prefix ekle
  const cleanPath = url.startsWith('/') ? url : `/${url}`;
  return `${CDN_BASE_URL}${cleanPath}`;
};

/**
 * Thumbnail URL'ini optimize et
 * CDN'de resize/optimize parametreleri ekler
 * @param {string} url - Orijinal thumbnail URL
 * @param {object} options - Resize options
 * @returns {string} Optimized CDN URL
 */
const getOptimizedThumbnail = (url, options = {}) => {
  const {
    width = 400,
    height = 600,
    quality = 80,
    format = 'webp'
  } = options;

  const cdnUrl = toCdnUrl(url, 'thumbnail');
  
  if (!CDN_ENABLED || !CDN_BASE_URL) {
    return cdnUrl;
  }

  // CDN query parameters for image optimization
  // Bu format Cloudflare, imgix, CloudFront gibi CDN'lerde çalışır
  const separator = cdnUrl.includes('?') ? '&' : '?';
  return `${cdnUrl}${separator}w=${width}&h=${height}&q=${quality}&f=${format}`;
};

/**
 * Gift animasyon/resim URL'ini CDN'e çevir
 */
const getGiftUrl = (url) => {
  return toCdnUrl(url, 'gift');
};

/**
 * Profil resmi URL'ini CDN'e çevir
 */
const getProfileImageUrl = (url) => {
  return toCdnUrl(url, 'profile');
};

/**
 * Stream thumbnail'ini CDN URL'ine çevir ve optimize et
 */
const getStreamThumbnail = (stream) => {
  if (!stream) return '';
  
  // Önce stream thumbnail, yoksa host profil resmi
  const url = stream.thumbnailUrl || stream.host?.profileImage || '';
  return getOptimizedThumbnail(url, {
    width: 400,
    height: 600,
    quality: 80
  });
};

/**
 * Stream listesi için thumbnail'leri optimize et
 */
const optimizeStreamList = (streams) => {
  if (!Array.isArray(streams)) return streams;
  
  return streams.map(stream => ({
    ...stream,
    thumbnailUrl: getStreamThumbnail(stream),
    host: stream.host ? {
      ...stream.host,
      profileImage: getProfileImageUrl(stream.host.profileImage)
    } : stream.host
  }));
};

module.exports = {
  toCdnUrl,
  getOptimizedThumbnail,
  getGiftUrl,
  getProfileImageUrl,
  getStreamThumbnail,
  optimizeStreamList,
  CDN_ENABLED,
  CDN_BASE_URL
};

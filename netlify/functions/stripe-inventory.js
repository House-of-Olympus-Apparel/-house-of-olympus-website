const crypto = require('crypto');

const REPO = process.env.GITHUB_REPO || 'House-of-Olympus-Apparel/-house-of-olympus-website';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const PRODUCTS_PATH = 'data/products';
const STRIPE_API = 'https://api.stripe.com/v1';
const GITHUB_API = 'https://api.github.com';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch (_) {
    return false;
  }
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(',').map(p => p.trim());
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!timestamp || !signatures.length) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return signatures.some(sig => safeEqualHex(sig, expected));
}

async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
  const response = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stripe API ${response.status}: ${text}`);
  }
  return response.json();
}

async function githubGet(path) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  const response = await fetch(`${GITHUB_API}/repos/${REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'house-of-olympus-inventory-webhook'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
  return response.json();
}

async function githubPut(path, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  const response = await fetch(`${GITHUB_API}/repos/${REPO}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'house-of-olympus-inventory-webhook'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub update ${response.status}: ${text}`);
  }
  return response.json();
}

function getFrontMatterField(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.*)$`, 'mi'));
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function setFrontMatterField(text, key, value, insertAfterKey) {
  const line = `${key}: ${value}`;
  const fieldRegex = new RegExp(`^${key}:\\s*.*$`, 'mi');
  if (fieldRegex.test(text)) return text.replace(fieldRegex, line);

  if (insertAfterKey) {
    const afterRegex = new RegExp(`(^${insertAfterKey}:\\s*.*$)`, 'mi');
    if (afterRegex.test(text)) return text.replace(afterRegex, `$1\n${line}`);
  }

  const endFrontMatter = text.indexOf('\n---', 4);
  if (endFrontMatter !== -1) {
    return `${text.slice(0, endFrontMatter)}\n${line}${text.slice(endFrontMatter)}`;
  }
  return `${text.trimEnd()}\n${line}\n`;
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

async function findProductByPaymentLink(paymentLinkUrl) {
  const files = await githubGet(`/contents/${PRODUCTS_PATH}?ref=${encodeURIComponent(BRANCH)}`);
  const markdownFiles = files.filter(f => f.type === 'file' && /\.(md|markdown)$/i.test(f.name));

  for (const file of markdownFiles) {
    const full = await githubGet(`/contents/${encodeURIComponent(file.path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(BRANCH)}`);
    const text = Buffer.from(full.content, 'base64').toString('utf8');
    const storedUrl = normalizeUrl(getFrontMatterField(text, 'payment_link'));
    if (storedUrl && storedUrl === normalizeUrl(paymentLinkUrl)) {
      return { file, full, text };
    }
  }
  return null;
}

async function handlePaidSession(session) {
  if (!session?.id) throw new Error('Checkout Session missing id');
  if (session.payment_status && session.payment_status !== 'paid') {
    return { skipped: true, reason: `payment_status=${session.payment_status}` };
  }
  if (!session.payment_link) {
    return { skipped: true, reason: 'Checkout Session is not from a Payment Link' };
  }

  const paymentLink = await stripeGet(`/payment_links/${encodeURIComponent(session.payment_link)}`);
  if (!paymentLink.url) throw new Error('Stripe Payment Link has no URL');

  const lineItems = await stripeGet(`/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100`);
  const purchasedQuantity = (lineItems.data || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 1;

  const product = await findProductByPaymentLink(paymentLink.url);
  if (!product) {
    throw new Error(`No CMS product matches Stripe Payment Link ${paymentLink.url}`);
  }

  const priorSession = getFrontMatterField(product.text, 'last_stripe_session');
  if (priorSession === session.id) {
    return { duplicate: true, session: session.id, product: product.file.path };
  }

  const rawQuantity = getFrontMatterField(product.text, 'quantity');
  const currentQuantity = rawQuantity === '' ? 1 : Math.max(0, parseInt(rawQuantity, 10) || 0);
  const newQuantity = Math.max(0, currentQuantity - purchasedQuantity);

  let updated = product.text;
  updated = setFrontMatterField(updated, 'quantity', newQuantity, 'price');
  updated = setFrontMatterField(updated, 'status', newQuantity <= 0 ? 'Sold Out' : 'Available');
  updated = setFrontMatterField(updated, 'last_stripe_session', session.id, 'status');

  await githubPut(`/contents/${encodeURIComponent(product.file.path).replace(/%2F/g, '/')}`, {
    message: `Update inventory after Stripe sale ${session.id}`,
    content: Buffer.from(updated, 'utf8').toString('base64'),
    sha: product.full.sha,
    branch: BRANCH
  });

  return {
    session: session.id,
    product: product.file.path,
    purchasedQuantity,
    previousQuantity: currentQuantity,
    quantity: newQuantity,
    status: newQuantity <= 0 ? 'Sold Out' : 'Available'
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!verifyStripeSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)) {
    return json(400, { error: 'Invalid Stripe signature' });
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (_) {
    return json(400, { error: 'Invalid JSON' });
  }

  const supported = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
  if (!supported.has(stripeEvent.type)) {
    return json(200, { received: true, ignored: stripeEvent.type });
  }

  try {
    const result = await handlePaidSession(stripeEvent.data?.object);
    return json(200, { received: true, result });
  } catch (error) {
    console.error('Inventory webhook error:', error);
    return json(500, { error: error.message || 'Inventory update failed' });
  }
};

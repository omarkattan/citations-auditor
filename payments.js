// payments.js
// Stripe Checkout for the three credit packages, plus fulfillment that turns a
// paid session into an access code (stored in db.js). Active only when
// STRIPE_SECRET_KEY is set.

const db = require('./db');

let Stripe = null;
try {
  Stripe = require('stripe');
} catch {
  Stripe = null;
}

// Credits are spent per audited page: 1 credit for a standard audit, more for a
// fact-checked page (see FACTCHECK_CREDIT_COST in server.js). amount is in cents.
// Prices are set so a worst-case page still clears a 50%+ margin after costs.
const PACKAGES = {
  starter: { id: 'starter', name: 'Starter', amount: 1200, credits: 35 },
  pro: { id: 'pro', name: 'Pro', amount: 2000, credits: 65 },
  agency: { id: 'agency', name: 'Agency', amount: 3500, credits: 120 }
};

function enabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY) && Boolean(Stripe);
}

function client() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

async function createCheckout(packageId, origin) {
  if (!enabled()) throw new Error('Payments are not configured.');
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new Error('Unknown package.');

  const descriptor = (process.env.STRIPE_STATEMENT_DESCRIPTOR || 'SANDSTORM DIGITAL').slice(0, 22);
  const session = await client().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: `Claims Auditor ${pkg.name} - ${pkg.credits} page credits` },
          unit_amount: pkg.amount
        },
        quantity: 1
      }
    ],
    payment_intent_data: { statement_descriptor: descriptor },
    metadata: { packageId: pkg.id, credits: String(pkg.credits) },
    success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?canceled=1`
  });
  return session.url;
}

// Verify a session is paid and return (creating if needed) its access code.
async function fulfillSession(sessionId) {
  if (!enabled()) throw new Error('Payments are not configured.');
  if (!sessionId) throw new Error('Missing session id.');
  const session = await client().checkout.sessions.retrieve(sessionId);
  if (!session || session.payment_status !== 'paid') return null;
  const credits = parseInt((session.metadata && session.metadata.credits) || '0', 10);
  const email = (session.customer_details && session.customer_details.email) || null;
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
  return db.createCodeForSession(sessionId, email, credits, pi);
}

// Zero out the credits of any code tied to a refunded/disputed payment intent.
async function voidByPaymentIntent(paymentIntent) {
  if (!enabled() || !paymentIntent) return [];
  return db.voidByPaymentIntent(paymentIntent);
}

function verifyWebhook(rawBody, signature) {
  return client().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { PACKAGES, enabled, createCheckout, fulfillSession, voidByPaymentIntent, verifyWebhook };

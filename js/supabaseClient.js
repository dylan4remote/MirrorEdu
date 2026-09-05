// Loaded after the Supabase CDN script (window.supabase) on every page.
// Fetches the public config (URL + anon key - safe to expose, see
// api/config.js) and builds a single shared Supabase client.
let clientPromise = null;

function getSupabaseClient() {
  if (!clientPromise) {
    clientPromise = fetch('/api/config')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load app config from /api/config');
        return res.json();
      })
      .then(({ supabaseUrl, supabaseAnonKey }) => {
        return window.supabase.createClient(supabaseUrl, supabaseAnonKey);
      });
  }
  return clientPromise;
}

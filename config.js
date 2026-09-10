// Supabase connection — reuses the shared JFK project (same one the Warehouse Hub
// and Returns tracker use). The anon key is safe to expose in the browser;
// row-level-security policies on the recv_* tables control what it can do.
export const SUPABASE_URL = "https://iptnlqfitvmoiofzrmvx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwdG5scWZpdHZtb2lvZnpybXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMjk3MjMsImV4cCI6MjA5ODkwNTcyM30.j5JK6ONpAy_Tam2-jGPfiI3fHgOKu75BDQDJXkftx7s";

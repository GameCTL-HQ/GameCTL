export function getToken() {
  return (
    localStorage.getItem("token") ??
    localStorage.getItem("jwt") ??
    sessionStorage.getItem("token") ??
    sessionStorage.getItem("jwt") ?? null
  );
}

export function authHeader() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

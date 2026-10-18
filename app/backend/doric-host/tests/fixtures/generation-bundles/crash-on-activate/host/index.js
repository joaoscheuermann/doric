// A plain-JS installed bundle whose activation ends its process, so the
// generation it belongs to never starts.
export const activate = () => {
  process.exit(1);
};

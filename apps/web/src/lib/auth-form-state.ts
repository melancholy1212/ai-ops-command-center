// Shared by the sign-in form (client) and its server actions. No dependencies, so it stays tiny in the bundle.
export interface AuthFormState {
  error: string | null;
  notice: string | null;
}

export const initialAuthFormState: AuthFormState = { error: null, notice: null };

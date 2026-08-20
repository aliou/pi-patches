{
  pkgs ? import <nixpkgs> { },
}:
pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs
    pnpm_11
    gnutar
    patch
  ];
}

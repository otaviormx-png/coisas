"""Prepara somente dependências locais, sem instalar ou trocar o servidor Firebird."""
import hashlib
from pathlib import Path
import struct
import subprocess
import sys
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parent
URL='https://github.com/FirebirdSQL/firebird/releases/download/R2_5_9/Firebird-2.5.9.27139-0_x64.zip'
SHA256='707e05bae8994b06cec60815a292078db82d8e75616f4dd514b7e417a3ee2137'

def main():
    if struct.calcsize('P')!=8:raise SystemExit('Use Python de 64 bits, versão 3.11 ou posterior.')
    runtime=ROOT/'.runtime';runtime.mkdir(exist_ok=True)
    target=runtime/'firebird'
    if not (target/'bin'/'fbclient.dll').is_file():
        archive=runtime/'firebird_download.zip'
        print('Baixando o cliente Firebird do repositório oficial...')
        urllib.request.urlretrieve(URL,archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest()!=SHA256:
            raise SystemExit('O arquivo baixado não corresponde à versão verificada. Não foi executado.')
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                path=(target/name).resolve()
                if not path.is_relative_to(target.resolve()):raise SystemExit('Caminho inesperado no pacote.')
            z.extractall(target)
        archive.unlink()
    subprocess.run([sys.executable,'-m','pip','install','--index-url','https://pypi.org/simple',
                    '--target',str(runtime/'python'),'-r',str(ROOT/'requirements.txt')],check=True)
    print('Pronto. Abra o atalho BPA ou GIL nesta pasta. Informe a senha somente na tela.')

if __name__=='__main__':main()

"""Ponte privada por entrada/saída padrão. Não abre servidor ou porta."""
import argparse
import json
import sys
from native_session import Session

MAX_REQUEST = 32 * 1024 * 1024


def main():
    # O protocolo independe da página de códigos do terminal/processo pai.
    sys.stdout.reconfigure(encoding='utf-8',errors='strict')
    sys.stderr.reconfigure(encoding='utf-8',errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['bpa', 'gil'], default='bpa')
    args = parser.parse_args()
    session = Session(args.mode)
    while True:
        line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
        if not line:
            break
        request = None
        ident = None
        try:
            if len(line) > MAX_REQUEST:
                raise ValueError('O pedido excede o limite de tamanho.')
            request = json.loads(line.decode('utf-8-sig'))
            if not isinstance(request, dict) or not isinstance(request.get('data', {}), dict):
                raise ValueError('Formato de pedido inválido.')
            ident = request.get('id')
            result = session.action(request.get('action'), request.get('data', {}))
            response = {'id': ident, 'ok': True, 'data': result}
        except Exception as exc:
            session.simulated = None
            response = {'id': ident, 'ok': False, 'error': str(exc)}
        finally:
            if isinstance(request, dict) and isinstance(request.get('data'), dict):
                request['data'].pop('password', None)
        sys.stdout.write(json.dumps(response, ensure_ascii=False, default=str) + '\n')
        sys.stdout.flush()
        if len(line) > MAX_REQUEST or (isinstance(request, dict) and request.get('action') == 'close'):
            break
        line = request = None
    session.payload = session.plan = None


if __name__ == '__main__':
    main()

import { ArgumentsHost, Catch, UnauthorizedException } from '@nestjs/common'
import { BaseWsExceptionFilter } from '@nestjs/websockets'
import { Socket } from 'socket.io'

@Catch(UnauthorizedException)
export class WsExceptionsFilter extends BaseWsExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        super.catch(exception, host)

        console.log('jpk ????')
        const [socket] = host.getArgs<[Socket]>()
        socket.emit('unauthorizedException', {
            status: 'error',
            message: `Unauthorized`,
        })
    }
}

import { UseFilters, UseGuards } from '@nestjs/common'
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import { instanceToInstance as classToClass } from 'class-transformer'
import { Server } from 'socket.io'

import { WsNotFoundExceptionFilter } from '../auth/exception-filter/ws-not-found.exception-filter'
import { WsGuard } from '../auth/guards/ws.guard'
import { Lobby } from './entities/lobby.entity'

@UseFilters(WsNotFoundExceptionFilter)
@WebSocketGateway({
    cors: {
        origin: '*',
    },
    namespace: '/list',
})
@UseGuards(WsGuard)
export class LobbyListGateway {
    @WebSocketServer()
    server: Server

    sendLobbyList(lobbies: Lobby[]): void {
        this.server.emit('lobbyList', classToClass<Lobby>(lobbies, { groups: ['lobby-list'] }))
    }
}

import {
    Body,
    CACHE_MANAGER,
    ClassSerializerInterceptor,
    Controller,
    ForbiddenException,
    Get,
    Inject,
    NotFoundException,
    Param,
    Post,
    Put,
    Query,
    Req,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Cache } from 'cache-manager'
import { Request } from 'express'
import { Repository } from 'typeorm'

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { GameToMusic } from '../games/entity/game-to-music.entity'
import { Game } from '../games/entity/game.entity'
import { Music } from '../games/entity/music.entity'
import { User } from '../users/user.entity'
import { LobbyCreateDto } from './dto/lobby-create.dto'
import { LobbySearchDto } from './dto/lobby-search.dto'
import { LobbyUser, LobbyUserRole } from './entities/lobby-user.entity'
import { Lobby, LobbyStatuses } from './entities/lobby.entity'
import { LobbyService } from './lobby.service'

@Controller('lobbies')
@UseGuards(JwtAuthGuard)
export class LobbyController {
    constructor(
        @InjectRepository(Lobby)
        private lobbyRepository: Repository<Lobby>,
        private lobbyService: LobbyService,
        @InjectRepository(LobbyUser)
        private lobbyUserRepository: Repository<LobbyUser>,
        @InjectRepository(Music)
        private musicRepository: Repository<Music>,
        @InjectRepository(Game)
        private gameRepository: Repository<Game>,
        @InjectRepository(GameToMusic)
        private gameToMusicRepository: Repository<GameToMusic>,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) {}

    @UseInterceptors(ClassSerializerInterceptor)
    @Get('')
    getAll(@Query() query: LobbySearchDto): Promise<Lobby[]> {
        return this.lobbyService.findByName(query.query)
    }

    @Post('/create')
    create(@Body() data: LobbyCreateDto, @Req() request: Request): Promise<Lobby> {
        return this.lobbyService.create(data, request.user as User)
    }

    @Put(':code')
    async update(
        @Body() data: LobbyCreateDto,
        @Param('code') code: string,
        @Req() request: Request,
    ): Promise<void> {
        const lobby = await this.lobbyRepository.findOne({
            code,
        })
        if (lobby === undefined) {
            throw new NotFoundException()
        }

        const player = await this.lobbyUserRepository.findOne({
            relations: ['user'],
            where: {
                user: request.user,
                role: LobbyUserRole.Host,
            },
        })
        if (player === undefined) {
            throw new ForbiddenException()
        }
        return this.lobbyService.update(lobby, data)
    }

    @Get('leave')
    async leave(@Req() request: Request): Promise<void> {
        const lobbyUser = await this.lobbyUserRepository.findOne({
            relations: ['user', 'lobby'],
            where: {
                user: request.user,
            },
        })
        if (lobbyUser === undefined) {
            throw new NotFoundException()
        }

        if (
            lobbyUser.lobby.status === LobbyStatuses.Waiting ||
            lobbyUser.role === LobbyUserRole.Spectator
        ) {
            await this.lobbyUserRepository.remove(lobbyUser)
        } else {
            await this.lobbyUserRepository.save({ ...lobbyUser, disconnected: true })
        }
    }
}